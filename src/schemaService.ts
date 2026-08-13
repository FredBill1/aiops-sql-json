import * as os from 'node:os';

import * as vscode from 'vscode';

import type { ExtensionConfiguration } from './config';
import {
  resolveSchemaPatterns,
  type ResolvedSchemaPattern,
  type SchemaPatternContext,
} from './schemaPatterns';
import { createSchemaSnapshot, parseDdlSchema, type SchemaIssue, type SchemaSnapshot } from './sqlSchemaCore';

const EMPTY_SCHEMA: SchemaSnapshot = { tables: [], issues: [] };

interface SchemaBuildResult {
  snapshot: SchemaSnapshot;
  sources?: readonly { uri: vscode.Uri; text: string }[];
}

interface SchemaCacheEntry {
  generation: number;
  promise: Promise<SchemaBuildResult>;
  committed: boolean;
}

export interface SchemaRebuildRequest {
  resource: vscode.Uri;
  configuration: ExtensionConfiguration;
}

export class SqlSchemaService implements vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSchema = this.changedEmitter.event;

  private readonly diagnostics = vscode.languages.createDiagnosticCollection('aiops-sql-schema');
  private readonly cache = new Map<string, SchemaCacheEntry>();
  private readonly lastGood = new Map<string, SchemaSnapshot>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly schemaUris = new Set<string>();
  private readonly diagnosticContributions = new Map<string, Map<string, vscode.Diagnostic[]>>();
  private readonly reportedPatternIssues = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private invalidationTimer: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.schemaUris.has(event.document.uri.toString())) {
          this.invalidate();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.schemaUris.has(document.uri.toString())) {
          this.invalidate();
        }
      }),
      vscode.workspace.onDidCreateFiles(() => this.invalidate()),
      vscode.workspace.onDidDeleteFiles(() => this.invalidate()),
      vscode.workspace.onDidRenameFiles(() => this.invalidate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.clear()),
    );
  }

  async getSchema(
    resource: vscode.Uri,
    configuration: ExtensionConfiguration,
  ): Promise<SchemaSnapshot> {
    if (!configuration.schemaValidationEnabled) {
      return EMPTY_SCHEMA;
    }
    if (configuration.schemaFileGlobs.length === 0) {
      return EMPTY_SCHEMA;
    }
    const resolved = resolveSchemaPatterns(configuration.schemaFileGlobs, createPatternContext(resource));
    this.reportPatternIssues(
      resolved.issues,
      JSON.stringify({ schemaFiles: configuration.schemaFileGlobs }),
    );
    if (resolved.patterns.length === 0) return EMPTY_SCHEMA;
    const key = JSON.stringify({
      dialect: configuration.dialect,
      patterns: resolved.patterns.map((pattern) => ({
        base: pattern.baseLocation,
        glob: pattern.glob,
      })),
      udfs: configuration.udfs,
      schemaDiagnostics: !configuration.schemaValidationCompletionOnly,
    });
    const existing = this.cache.get(key);
    if (existing) {
      return this.resolveEntry(key, existing, configuration);
    }
    for (const pattern of resolved.patterns) {
      this.ensureWatchers(pattern);
    }
    const fallback = this.lastGood.get(key) ?? EMPTY_SCHEMA;
    const entry: SchemaCacheEntry = {
      generation: this.generation,
      promise: this.buildSchema(resolved.patterns, configuration, this.generation).catch(() => ({ snapshot: fallback })),
      committed: false,
    };
    this.cache.set(key, entry);
    return this.resolveEntry(key, entry, configuration);
  }

  async rebuild(requests: readonly SchemaRebuildRequest[]): Promise<void> {
    this.reset();
    const enabledRequests = requests.filter((request) => request.configuration.schemaValidationEnabled);
    while (true) {
      const rebuildGeneration = this.generation;
      await Promise.all(enabledRequests.map((request) => this.getSchema(
        request.resource,
        request.configuration,
      )));
      if (this.generation === rebuildGeneration) {
        this.changedEmitter.fire();
        return;
      }
    }
  }

  clear(): void {
    this.reset();
    this.changedEmitter.fire();
  }

  dispose(): void {
    if (this.invalidationTimer) {
      clearTimeout(this.invalidationTimer);
    }
    this.clear();
    this.diagnostics.dispose();
    this.changedEmitter.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async buildSchema(
    patterns: readonly ResolvedSchemaPattern[],
    configuration: ExtensionConfiguration,
    generation: number,
  ): Promise<SchemaBuildResult> {
    const uris = new Map<string, vscode.Uri>();
    for (const pattern of patterns) {
      const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(
        uriFromLocation(pattern.baseLocation),
        pattern.glob,
      ));
      for (const uri of matches) {
        if (uri.path.toLocaleLowerCase().endsWith('.sql')) {
          uris.set(uri.toString(), uri);
        }
      }
    }
    const parsed = await Promise.all([...uris.values()].sort((left, right) => (
      left.toString().localeCompare(right.toString())
    )).map(async (uri) => {
      if (generation === this.generation) {
        this.schemaUris.add(uri.toString());
      }
      const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      const text = openDocument?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      return { uri, text, parsed: parseDdlSchema(text, configuration.dialect, uri.toString()) };
    }));
    const snapshot = createSchemaSnapshot(parsed.map((item) => item.parsed), configuration.udfs);
    return {
      snapshot,
      sources: parsed.map((item) => ({ uri: item.uri, text: item.text })),
    };
  }

  private async resolveEntry(
    key: string,
    entry: SchemaCacheEntry,
    configuration: ExtensionConfiguration,
  ): Promise<SchemaSnapshot> {
    const result = await entry.promise;
    if (entry.generation !== this.generation || this.cache.get(key) !== entry) {
      return EMPTY_SCHEMA;
    }
    if (!entry.committed) {
      entry.committed = true;
      this.lastGood.set(key, result.snapshot);
      if (result.sources) {
        for (const source of result.sources) {
          this.schemaUris.add(source.uri.toString());
        }
        if (!configuration.schemaValidationCompletionOnly) {
          this.updateDiagnosticContribution(key, result.sources, result.snapshot.issues);
        }
      }
    }
    return result.snapshot;
  }

  private ensureWatchers(pattern: ResolvedSchemaPattern): void {
    const base = uriFromLocation(pattern.baseLocation);
    this.ensureWatcher(base, pattern.glob);
    this.ensureWatcher(base, '**/*');
    const parent = vscode.Uri.joinPath(base, '..');
    if (parent.toString() !== base.toString()) {
      this.ensureWatcher(parent, '*');
    }
  }

  private ensureWatcher(base: vscode.Uri, glob: string): void {
    const key = `${base.toString()}\n${glob}`;
    if (this.watchers.has(key)) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob));
    watcher.onDidCreate(() => this.invalidate());
    watcher.onDidChange(() => this.invalidate());
    watcher.onDidDelete(() => this.invalidate());
    this.watchers.set(key, watcher);
  }

  private reportPatternIssues(issues: readonly string[], signature: string): void {
    for (const issue of issues) {
      const key = `${signature}\n${issue}`;
      if (this.reportedPatternIssues.has(key)) continue;
      this.reportedPatternIssues.add(key);
      void vscode.window.showWarningMessage(`AIOps SQL JSON: ${issue}`);
    }
  }

  private invalidate(): void {
    if (this.invalidationTimer) {
      clearTimeout(this.invalidationTimer);
    }
    this.invalidationTimer = setTimeout(() => {
      this.invalidationTimer = undefined;
      this.generation += 1;
      this.cache.clear();
      this.diagnosticContributions.clear();
      this.diagnostics.clear();
      this.changedEmitter.fire();
    }, 150);
  }

  private updateDiagnosticContribution(
    key: string,
    sources: readonly { uri: vscode.Uri; text: string }[],
    issues: readonly SchemaIssue[],
  ): void {
    const sourceByUri = new Map(sources.map((source) => [source.uri.toString(), source]));
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const issue of issues) {
      const source = sourceByUri.get(issue.source);
      if (!source) {
        continue;
      }
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(positionAt(source.text, issue.start), positionAt(source.text, issue.end)),
        issue.message,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = 'SQL schema DDL';
      diagnostic.code = issue.code;
      const list = grouped.get(issue.source) ?? [];
      list.push(diagnostic);
      grouped.set(issue.source, list);
    }
    this.diagnosticContributions.set(key, grouped);
    this.publishDiagnosticContributions();
  }

  private publishDiagnosticContributions(): void {
    const combined = new Map<string, vscode.Diagnostic[]>();
    const seen = new Map<string, Set<string>>();
    for (const contribution of this.diagnosticContributions.values()) {
      for (const [source, diagnostics] of contribution) {
        const target = combined.get(source) ?? [];
        const sourceSeen = seen.get(source) ?? new Set<string>();
        for (const diagnostic of diagnostics) {
          const signature = [
            diagnostic.range.start.line,
            diagnostic.range.start.character,
            diagnostic.range.end.line,
            diagnostic.range.end.character,
            diagnostic.severity,
            String(diagnostic.code),
            diagnostic.message,
          ].join(':');
          if (!sourceSeen.has(signature)) {
            sourceSeen.add(signature);
            target.push(diagnostic);
          }
        }
        combined.set(source, target);
        seen.set(source, sourceSeen);
      }
    }
    this.diagnostics.clear();
    for (const [source, diagnostics] of combined) {
      this.diagnostics.set(vscode.Uri.parse(source), diagnostics);
    }
  }

  private reset(): void {
    if (this.invalidationTimer) {
      clearTimeout(this.invalidationTimer);
      this.invalidationTimer = undefined;
    }
    this.generation += 1;
    this.cache.clear();
    this.lastGood.clear();
    this.schemaUris.clear();
    this.diagnosticContributions.clear();
    this.diagnostics.clear();
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }
}

function positionAt(text: string, requestedOffset: number): vscode.Position {
  const offset = Math.min(Math.max(requestedOffset, 0), text.length);
  let line = 0;
  let character = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n' && index + 1 < offset) {
        index += 1;
      }
      line += 1;
      character = 0;
    } else if (text[index] === '\n') {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return new vscode.Position(line, character);
}

function createPatternContext(resource: vscode.Uri): SchemaPatternContext {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const resourceWorkspace = vscode.workspace.getWorkspaceFolder(resource);
  return {
    resourceLocation: locationFromUri(resource),
    workspaceFolders: workspaceFolders.map((folder) => ({
      name: folder.name,
      location: locationFromUri(folder.uri),
    })),
    resourceWorkspaceName: resourceWorkspace?.name,
    userHome: os.homedir(),
    cwd: process.cwd(),
    execPath: process.execPath,
    pathSeparator: process.platform === 'win32' ? '\\' : '/',
    env: process.env,
  };
}

function locationFromUri(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

function uriFromLocation(location: string): vscode.Uri {
  return /^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(location)
    ? vscode.Uri.parse(location)
    : vscode.Uri.file(location);
}
