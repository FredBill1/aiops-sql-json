import * as vscode from 'vscode';

import { analyzePlainSqlDocument, analyzeSqlJsonRegions, findSqlRegions, validateJsonDocument } from './analysis';
import { affectsSqlConfiguration, getExtensionConfiguration, isPlainSqlEnabled, type ExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import type { SqlSchemaService } from './schemaService';
import type { SqlAnalysisProgress, SqlAnalysisRequest } from './sqlAnalysisProgress';
import type { SqlService } from './sqlService';
import { isSqlRequestCancelled, sqlServiceFailureMessage, waitForSqlRequest } from './sqlServiceContext';

interface Validation {
  document: vscode.TextDocument;
  key: string;
  version: number;
  generation: number;
  request?: SqlAnalysisRequest;
  timer?: NodeJS.Timeout;
  running: boolean;
  refresh: boolean;
  force: boolean;
}

export class DiagnosticController implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('aiops-sql-json');
  private readonly jsonDiagnostics = vscode.languages.createDiagnosticCollection('aiops-sql-json-structure');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly validations = new Map<string, Validation>();
  private readonly warnedConfigurationIssues = new Set<string>();
  private disposed = false;

  constructor(
    private readonly jsonServices: JsonServiceManager,
    private readonly refreshSemanticTokens: () => void,
    private readonly schemas: SqlSchemaService,
    private readonly sqlService: SqlService,
    private readonly progress: SqlAnalysisProgress,
  ) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document, 0)),
      vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.close(document)),
      this.progress.onDidPauseDocument((document) => {
        this.discard(document.uri.toString());
        this.collection.delete(document.uri);
        this.schedule(document, 0);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (affectsSqlConfiguration(event) || event.affectsConfiguration('json.schemas')
          || event.affectsConfiguration('json.schemaDownload.enable')) {
          this.progress.resetDocuments();
          this.jsonServices.clear();
          this.schemas.clear();
          this.sqlService.clear();
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
      this.sqlService.onDidRecover((event) => {
        this.refreshSemanticTokens();
        if (event.lane === 'analysis') {
          for (const document of vscode.workspace.textDocuments) {
            this.schedule(document, 0);
          }
        }
      }),
    );

    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document, 0);
    }
  }

  forceReparse(document: vscode.TextDocument): void {
    if (!isSupportedDocument(document) || document.isClosed
      || (document.languageId === 'sql' && !isPlainSqlEnabled(document.uri))) return;
    const key = document.uri.toString();
    this.discard(key);
    this.progress.restartDocument(document);
    this.sqlService.invalidateDocumentParsing(key);
    this.schedule(document, 0, true);
  }

  private schedule(document: vscode.TextDocument, delay = 250, force = false): void {
    if (this.disposed || document.isClosed || !isSupportedDocument(document)) return;
    const key = document.uri.toString();
    this.progress.updateDocument(document);
    this.sqlService.updateDocument(key, document.version);
    const previous = this.validations.get(key);
    if (previous?.document === document && this.isCurrent(previous)) {
      if (previous.running) { previous.refresh = true; return; }
      if (previous.timer) return;
    }
    this.discard(key);
    const enabled = document.languageId === 'sql-json' || isPlainSqlEnabled(document.uri);
    const job: Validation = {
      key, document, version: document.version, generation: this.sqlService.generation,
      request: enabled ? this.progress.beginDocument(document) : undefined,
      running: false, refresh: false, force,
    };
    this.validations.set(key, job);
    job.timer = setTimeout(() => {
      job.timer = undefined;
      void this.validate(job);
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    for (const key of this.validations.keys()) this.discard(key);
    this.collection.dispose();
    this.jsonDiagnostics.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async validate(job: Validation): Promise<void> {
    const { document, request } = job;
    job.running = true;
    let outcome: 'ready' | 'failed' | undefined;
    try {
      if (!this.isCurrent(job)) return;
      const configuration = getExtensionConfiguration(document.uri);
      this.warnAboutConfiguration(configuration.placeholderIssues);
      const projected = document.languageId === 'sql-json' ? this.jsonServices.createDocument(document, configuration) : undefined;
      const regions = projected ? findSqlRegions(projected, configuration) : [];
      if (projected) {
        void validateJsonDocument(document, projected, configuration, regions).then((diagnostics) => {
          if (this.isCurrent(job)) this.jsonDiagnostics.set(document.uri, diagnostics);
        }, (error: unknown) => {
          if (this.isCurrent(job)) this.jsonDiagnostics.set(document.uri, [incompleteDiagnostic(
            'json-validation-incomplete', `JSON validation could not complete: ${String(error)}`,
          )]);
        });
      }
      if (!request) {
        this.collection.delete(document.uri);
        return;
      }
      const { schemaKey, schemaFailure, validationConfiguration } = await this.schemaFor(document, configuration, request);
      if (!this.isCurrent(job) || request.cancellation.isCancellationRequested) return;
      const parse = { ...request, freshParse: job.force };
      const { diagnostics, failed } = projected
        ? await analyzeSqlJsonRegions(document, projected, regions, validationConfiguration, this.sqlService, parse, schemaKey)
        : { diagnostics: await analyzePlainSqlDocument(document, validationConfiguration, this.sqlService, parse, schemaKey), failed: false };
      if (!this.isCurrent(job) || request.cancellation.isCancellationRequested) return;
      if (schemaFailure) diagnostics.push(incompleteDiagnostic('sql-schema-incomplete', `SQL Schema indexing could not complete. ${schemaFailure}`));
      this.collection.set(document.uri, diagnostics);
      outcome = failed ? 'failed' : 'ready';
    } catch (error) {
      if (isSqlRequestCancelled(error) || !this.isCurrent(job) || request?.cancellation.isCancellationRequested) return;
      const diagnostic = incompleteDiagnostic('sql-analysis-incomplete', sqlServiceFailureMessage(error),
        new vscode.Range(document.positionAt(0), document.positionAt(Math.min(1, document.getText().length))));
      (request ? this.collection : this.jsonDiagnostics).set(document.uri, [diagnostic]);
      outcome = 'failed';
    } finally {
      request?.finish(outcome);
      job.request = undefined;
      job.running = false;
      if (job.refresh && this.isCurrent(job)) this.schedule(document, 0, job.force && !outcome);
    }
  }

  private async schemaFor(document: vscode.TextDocument, configuration: ExtensionConfiguration, request: SqlAnalysisRequest) {
    const schema = await waitForSqlRequest(this.schemas.getSchema(document.uri, configuration), request.cancellation);
    const schemaKey = this.schemas.getSchemaKey(schema);
    const schemaFailure = this.schemas.getSchemaFailure(schema);
    const syntaxOnly = !schemaKey && (schemaFailure || this.schemas.isIndexPaused(document.uri, configuration));
    return { schemaKey, schemaFailure, validationConfiguration: syntaxOnly
      ? { ...configuration, schemaValidationCompletionOnly: true } : configuration };
  }

  private isCurrent(job: Validation): boolean {
    return !this.disposed && !job.document.isClosed && job.document.version === job.version
      && this.sqlService.generation === job.generation && this.validations.get(job.key) === job;
  }

  private discard(key: string): void {
    const job = this.validations.get(key);
    if (!job) return;
    this.validations.delete(key);
    if (job.timer) clearTimeout(job.timer);
    job.request?.cancel();
  }

  private close(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.discard(key);
    this.progress.closeDocument(document);
    this.collection.delete(document.uri);
    this.jsonDiagnostics.delete(document.uri);
    this.sqlService.clearDocument(key);
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

function incompleteDiagnostic(code: string, message: string, range = new vscode.Range(0, 0, 0, 0)): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
  diagnostic.source = 'AIOps SQL JSON';
  diagnostic.code = code;
  return diagnostic;
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'sql-json' || document.languageId === 'sql';
}
