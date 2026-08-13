import * as vscode from 'vscode';

import { analyzePlainSqlDocument, analyzeSqlJsonDocument } from './analysis';
import { getExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import type { SqlSchemaService } from './schemaService';

export class DiagnosticController implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('aiops-sql-json');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly validationRequests = new Map<string, number>();
  private readonly warnedConfigurationIssues = new Set<string>();
  private disposed = false;

  constructor(
    private readonly jsonServices: JsonServiceManager,
    private readonly refreshSemanticTokens: () => void,
    private readonly schemas: SqlSchemaService,
  ) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document, 0)),
      vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.close(document)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('aiopsSqlJson') || event.affectsConfiguration('json.schemas')
          || event.affectsConfiguration('json.schemaDownload.enable')) {
          this.jsonServices.clear();
          this.schemas.clear();
          this.refreshSemanticTokens();
          for (const document of vscode.workspace.textDocuments) {
            this.schedule(document, 0);
          }
        }
      }),
      vscode.extensions.onDidChange(() => {
        this.jsonServices.clear();
        for (const document of vscode.workspace.textDocuments) {
          this.schedule(document, 0);
        }
      }),
      this.schemas.onDidChangeSchema(() => {
        for (const document of vscode.workspace.textDocuments) {
          this.schedule(document, 0);
        }
      }),
    );

    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document, 0);
    }
  }

  schedule(document: vscode.TextDocument, delay = 250): void {
    if (!isSupportedDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    const request = (this.validationRequests.get(key) ?? 0) + 1;
    this.validationRequests.set(key, request);
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.validate(document, request);
    }, delay));
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.validationRequests.clear();
    this.collection.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async validate(document: vscode.TextDocument, request: number): Promise<void> {
    if (this.disposed || document.isClosed) {
      return;
    }
    const version = document.version;
    const configuration = getExtensionConfiguration(document.uri);
    this.warnAboutConfiguration(configuration.placeholderIssues);
    const schema = await this.schemas.getSchema(document.uri, configuration);

    let diagnostics: vscode.Diagnostic[];
    if (document.languageId === 'sql-json') {
      const projected = this.jsonServices.createDocument(document, configuration);
      diagnostics = (await analyzeSqlJsonDocument(document, projected, configuration, schema)).diagnostics;
    } else if (document.languageId === 'sql' && configuration.plainSqlEnabled) {
      diagnostics = analyzePlainSqlDocument(document, configuration, schema).diagnostics;
    } else {
      diagnostics = [];
    }

    if (!this.disposed && !document.isClosed && document.version === version
      && this.validationRequests.get(document.uri.toString()) === request) {
      this.collection.set(document.uri, diagnostics);
    }
  }

  private close(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.validationRequests.delete(key);
    this.collection.delete(document.uri);
  }

  private warnAboutConfiguration(issues: readonly string[]): void {
    for (const issue of issues) {
      if (!this.warnedConfigurationIssues.has(issue)) {
        this.warnedConfigurationIssues.add(issue);
        void vscode.window.showWarningMessage(`AIOps SQL JSON：${issue}`);
      }
    }
  }
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'sql-json' || document.languageId === 'sql';
}
