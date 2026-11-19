import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiagnosticController } from '../../src/diagnostics';
import { SqlDocumentFormattingProvider } from '../../src/formattingProvider';
import { JsonServiceManager } from '../../src/jsonService';
import type { SqlSchemaService } from '../../src/schemaService';
import { SqlAnalysisProgress } from '../../src/sqlAnalysisProgress';
import type { SqlService } from '../../src/sqlService';
import { waitForSqlRequest } from '../../src/sqlServiceContext';

const host = vi.hoisted(() => {
  class Emitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
    dispose(): void { this.listeners.clear(); }
  }
  class Cancellation {
    private readonly emitter = new Emitter<void>();
    readonly token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
    cancel(): void { this.token.isCancellationRequested = true; this.emitter.fire(); }
    dispose(): void { this.emitter.dispose(); }
  }
  const edit = new Emitter<{ document: vscode.TextDocument }>();
  const settings = new Emitter<vscode.ConfigurationChangeEvent>();
  const activeEditor = new Emitter<void>();
  const noopEvent = () => ({ dispose: () => undefined });
  const status = { text: '', command: undefined, show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
  const notifications: { cancel: Cancellation; messages: string[]; closed: boolean; title: string }[] = [];
  const retry = vi.fn<() => Promise<string | undefined>>();
  const commands = new Map<string, () => Promise<void>>();
  const collections = new Map<string, Map<string, vscode.Diagnostic[]>>();
  const config = { delay: 2_000 };
  const workspace = {
    textDocuments: [] as vscode.TextDocument[],
    getConfiguration: () => ({ get: (name: string, fallback: unknown) => (
      name === 'aiopsSqlJson.analysis.slowNotificationMs' ? config.delay : fallback
    ) }),
    getWorkspaceFolder: () => undefined,
    asRelativePath: (uri: vscode.Uri) => uri.path,
    onDidChangeConfiguration: settings.event,
    onDidChangeTextDocument: edit.event,
    onDidOpenTextDocument: noopEvent,
    onDidCloseTextDocument: noopEvent,
  };
  const window = {
    activeTextEditor: undefined as Pick<vscode.TextEditor, 'document'> | undefined,
    onDidChangeActiveTextEditor: activeEditor.event,
    createStatusBarItem: () => status,
    showInformationMessage: retry,
    withProgress: (options: vscode.ProgressOptions, task: Parameters<typeof vscode.window.withProgress<void>>[1]) => {
      expect(options.cancellable).toBe(true);
      const notification = { cancel: new Cancellation(), messages: [] as string[], closed: false, title: options.title ?? '' };
      notifications.push(notification);
      return Promise.resolve(task({ report: (value) => notification.messages.push(value.message ?? '') }, notification.cancel.token))
        .finally(() => { notification.closed = true; });
    },
  };
  const app = {
    EventEmitter: Emitter,
    CancellationTokenSource: Cancellation,
    Diagnostic: class { constructor(readonly range: unknown, readonly message: string, readonly severity: number) {} },
    Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    EndOfLine: { CRLF: 2 },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Right: 2 },
    Disposable: { from: (...items: vscode.Disposable[]) => ({ dispose: () => items.forEach((item) => item.dispose()) }) },
    commands: {
      executeCommand: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
      registerCommand: (name: string, callback: () => Promise<void>) => {
        commands.set(name, callback);
        return { dispose: () => commands.delete(name) };
      },
    },
    extensions: { all: [], onDidChange: noopEvent },
    languages: {
      createDiagnosticCollection: (name: string) => {
        const results = new Map<string, vscode.Diagnostic[]>();
        collections.set(name, results);
        return {
          set: (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) => results.set(uri.toString(), diagnostics),
          delete: (uri: vscode.Uri) => results.delete(uri.toString()),
          dispose: () => results.clear(),
        };
      },
    },
    workspace,
    window,
  };
  return { app, activeEditor, config, commands, collections, status, retry, edit, settings, notifications };
});

vi.mock('vscode', () => host.app);

function document(path = '/query.sql', text = 'SELECT 1') {
  const uri = { path, scheme: 'file', toString: () => `file://${path}` };
  const document = { uri, version: 1, isClosed: false, languageId: path.endsWith('.json') ? 'sql-json' : 'sql',
    eol: 1, getText: () => text, positionAt: (offset: number) => ({ line: 0, character: offset }) };
  return { document: document as unknown as vscode.TextDocument, edit: (value: string) => { text = value; document.version += 1; } };
}

const disposables: vscode.Disposable[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  host.config.delay = 2_000;
  host.retry.mockReset();
  host.app.commands.executeCommand.mockClear();
  host.notifications.length = 0;
  host.app.workspace.textDocuments.length = 0;
  host.app.window.activeTextEditor = undefined;
});
afterEach(() => {
  disposables.splice(0).reverse().forEach((item) => item.dispose());
  vi.useRealTimers();
});

function createProgress(): SqlAnalysisProgress {
  const progress = new SqlAnalysisProgress();
  disposables.push(progress);
  return progress;
}

function focus(document: vscode.TextDocument): void {
  host.app.window.activeTextEditor = { document };
  host.activeEditor.fire();
}

async function clickStatus(): Promise<void> {
  const command = host.status.command;
  expect(command).toBeDefined();
  await host.commands.get(command!)!();
}

describe('SQL progress and cancellation', () => {
  it('counts from allocation, retimes a running task and closes the notification on completion', async () => {
    const progress = createProgress();
    const { document: sql } = document();
    focus(sql);
    disposables.push(progress.registerStatusBar({ schemaKey: () => undefined, retryDocument: vi.fn(), retrySchema: vi.fn() }));
    const request = progress.beginDocument(sql)!;
    expect(host.status.text).toContain('SQL Waiting');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.notifications).toHaveLength(0);
    request.onWorkerStart!();
    expect(host.status.text).toContain('SQL Analyzing');
    await vi.advanceTimersByTimeAsync(1_000);
    host.config.delay = 1_200;
    host.settings.fire({ affectsConfiguration: (key) => key === 'aiopsSqlJson.analysis.slowNotificationMs' });
    await vi.advanceTimersByTimeAsync(199);
    expect(host.notifications).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.notifications[0]?.messages.at(-1)).toBe('Taking longer than expected…');
    expect(request.cancellation.isCancellationRequested).toBe(false);
    request.finish('ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.notifications[0]?.closed).toBe(true);
    expect(host.status.text).toContain('SQL Ready');
  });

  it('reveals existing progress without duplicating the notice and ignores an obsolete Cancel', async () => {
    const progress = createProgress();
    const { document: sql, edit } = document();
    const other = document('/other.sql').document;
    focus(sql);
    const retryDocument = vi.fn((document: vscode.TextDocument) => progress.restartDocument(document));
    disposables.push(progress.registerStatusBar({ schemaKey: () => undefined, retryDocument, retrySchema: vi.fn() }));
    const request = progress.beginDocument(sql)!;
    const interactive = progress.beginDocument(sql)!;
    const independent = progress.beginDocument(other)!;
    await clickStatus();
    request.onWorkerStart!();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0]?.messages.at(-1)).toBe('Taking longer than expected…');
    await clickStatus();
    expect(host.app.commands.executeCommand).toHaveBeenCalledWith('notifications.showList');
    expect(host.notifications).toHaveLength(1);
    expect(progress.isDocumentPaused(sql)).toBe(false);

    host.notifications[0]?.cancel.cancel();
    expect(request.cancellation.isCancellationRequested).toBe(true);
    expect(interactive.cancellation.isCancellationRequested).toBe(true);
    expect(independent.cancellation.isCancellationRequested).toBe(false);
    expect(host.status.text).toContain('SQL Paused');
    edit('SELECT 2');
    expect(progress.beginDocument(sql)).toBeUndefined();
    host.retry.mockResolvedValueOnce('Retry');
    await clickStatus();
    expect(retryDocument).toHaveBeenCalledWith(sql);
    const resumed = progress.beginDocument(sql)!;
    host.notifications[0]?.cancel.cancel();
    expect(resumed.cancellation.isCancellationRequested).toBe(false);
    resumed.finish('failed');
    expect(host.status.text).toContain('SQL Analysis Failed');
  });

  it('keeps native request cancellation separate from pausing a shared Schema', async () => {
    const progress = createProgress();
    const { document: sql } = document();
    focus(sql);
    const retrySchema = vi.fn(async () => progress.resumeSchema('schema'));
    disposables.push(progress.registerStatusBar({ schemaKey: () => 'schema', retryDocument: vi.fn(), retrySchema }));
    const native = new host.app.CancellationTokenSource();
    const hover = progress.beginDocument(sql, native.token)!;
    native.cancel();
    expect(hover.cancellation.isCancellationRequested).toBe(true);
    expect(progress.isDocumentPaused(sql)).toBe(false);
    const schema = progress.beginSchema('schema', sql.uri)!;
    schema.onWorkerStart!();
    expect(host.status.text).toContain('SQL Indexing Schema');
    await clickStatus();
    expect(host.notifications[0]?.title).toContain('Shared SQL Schema indexing');
    host.notifications[0]?.cancel.cancel();
    expect(schema.cancellation.isCancellationRequested).toBe(true);
    expect(progress.isDocumentPaused(sql)).toBe(false);
    expect(host.status.text).toContain('Schema Paused');
    host.retry.mockResolvedValueOnce('Retry');
    await clickStatus();
    expect(retrySchema).toHaveBeenCalledWith(sql);
    expect(progress.isSchemaPaused('schema')).toBe(false);
  });

  it('continues JSON diagnostics during a pause and reparses every region on retry and on a completed file', async () => {
    const progress = createProgress();
    const { document: sql, edit } = document('/query.sql.json', '{"firstSql":"SEL\nECT 1","secondSql":"SELECT 2"}');
    focus(sql);
    host.app.workspace.textDocuments.push(sql);
    const fixture = { sql: { issues: [], tokens: [] }, semantics: [] };
    let finishFormat!: (value: string) => void;
    const formatPending = new Promise<string>((resolve) => { finishFormat = resolve; });
    const analyze = vi.fn<SqlService['analyze']>().mockImplementationOnce((_snapshot, _options, request) => {
      request!.onWorkerStart!();
      return waitForSqlRequest(new Promise(() => undefined), request!.cancellation!);
    }).mockResolvedValue(fixture);
    const worker = {
      generation: 0, analyze, updateDocument: vi.fn(), invalidateDocumentParsing: vi.fn(),
      formatJson: vi.fn<SqlService['formatJson']>().mockReturnValue(formatPending),
      onDidRecover: () => ({ dispose: () => undefined }),
    } as unknown as SqlService;
    const schemas = {
      getSchema: async () => ({}), getSchemaKey: () => undefined, getSchemaFailure: () => undefined,
      isIndexPaused: () => false, onDidChangeSchema: () => ({ dispose: () => undefined }),
    } as unknown as SqlSchemaService;
    const diagnostics = new DiagnosticController(new JsonServiceManager(), vi.fn(), schemas, worker, progress);
    disposables.push(diagnostics, progress.registerStatusBar({ schemaKey: () => undefined,
      retryDocument: (document) => diagnostics.forceReparse(document), retrySchema: vi.fn() }));
    await vi.advanceTimersByTimeAsync(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    await clickStatus();
    const formatting = new SqlDocumentFormattingProvider(worker, progress).provideDocumentFormattingEdits(
      sql, { tabSize: 4, insertSpaces: true }, new host.app.CancellationTokenSource().token,
    );
    host.notifications[0]?.cancel.cancel();
    edit('{"firstSql":"SEL\nECT 3","secondSql":"SELECT 4",}');
    host.edit.fire({ document: sql });
    await vi.advanceTimersByTimeAsync(251);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(host.collections.get('aiops-sql-json-structure')?.get(sql.uri.toString())).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'joined-by-platform' }), expect.objectContaining({ severity: 0 }),
    ]));
    expect(host.status.text).toContain('SQL Paused');

    host.retry.mockResolvedValueOnce('Retry');
    await clickStatus();
    await vi.advanceTimersByTimeAsync(1);
    expect(analyze.mock.calls.slice(1).map(([snapshot, , request]) => [snapshot.version, snapshot.text, request?.freshParse]))
      .toEqual([[2, 'SELECT 3', true], [2, 'SELECT 4', true]]);
    expect(host.status.text).toContain('SQL Ready');
    finishFormat('obsolete edit');
    expect(await formatting).toEqual([]);

    diagnostics.forceReparse(sql);
    await vi.advanceTimersByTimeAsync(1);
    expect(analyze.mock.calls.slice(3).map(([snapshot, , request]) => [snapshot.version, snapshot.text, request?.freshParse]))
      .toEqual([[2, 'SELECT 3', true], [2, 'SELECT 4', true]]);
    expect(worker.invalidateDocumentParsing).toHaveBeenCalledTimes(2);
  });
});
