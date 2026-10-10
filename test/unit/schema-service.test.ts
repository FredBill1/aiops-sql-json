import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionConfiguration } from '../../src/config';
import { SqlSchemaService } from '../../src/schemaService';
import { SqlServiceError, type SqlService } from '../../src/sqlService';
import type { SchemaSnapshot } from '../../src/sqlSchemaCore';
import { commentFormat } from './sql-comment-whitespace.cases';

const host = vi.hoisted(() => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void { for (const listener of this.listeners) listener(event); }
    dispose(): void { this.listeners.clear(); }
  }
  class Uri {
    readonly scheme = 'file';
    readonly fsPath: string;
    constructor(readonly path: string) { this.fsPath = path; }
    toString(): string { return `file://${this.path}`; }
    static file(path: string): Uri { return new Uri(path); }
    static parse(value: string): Uri { return new Uri(value.replace(/^file:\/\//u, '')); }
    static joinPath(base: Uri, path: string): Uri { return new Uri(`${base.path}/${path}`); }
  }
  class RelativePattern {
    constructor(readonly base: Uri, readonly pattern: string) {}
  }
  const change = new EventEmitter<{ document: { uri: Uri } }>();
  const inertEvent = () => ({ dispose: () => undefined });
  const ddlUri = Uri.file('/schemas/tables.sql');
  const sourceDocument = { uri: ddlUri, getText: vi.fn(() => 'CREATE TABLE example (id INT);') };
  const workspace = {
    workspaceFolders: [],
    textDocuments: [sourceDocument],
    findFiles: vi.fn(async () => [ddlUri]),
    fs: { readFile: vi.fn() },
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: inertEvent, onDidChange: inertEvent, onDidDelete: inertEvent,
      dispose: vi.fn(),
    })),
    onDidChangeTextDocument: change.event,
    onDidSaveTextDocument: inertEvent,
    onDidCreateFiles: inertEvent,
    onDidDeleteFiles: inertEvent,
    onDidRenameFiles: inertEvent,
    onDidChangeWorkspaceFolders: inertEvent,
  };
  const collection = { set: vi.fn(), clear: vi.fn(), dispose: vi.fn() };
  return { EventEmitter, Uri, RelativePattern, workspace, collection, change, ddlUri, sourceDocument };
});

vi.mock('vscode', () => ({
  EventEmitter: host.EventEmitter,
  Uri: host.Uri,
  RelativePattern: host.RelativePattern,
  workspace: host.workspace,
  languages: { createDiagnosticCollection: () => host.collection },
  window: { showWarningMessage: vi.fn() },
}));
vi.mock('../../src/resourceContext', () => ({ getResourceWorkspaceFolder: () => undefined }));
vi.mock('../../src/schemaPatterns', () => ({
  resolveSchemaPatterns: (sources: readonly string[]) => ({
    patterns: sources.map((glob) => ({ source: glob, baseLocation: '/schemas', glob })),
    issues: [],
  }),
}));

const resource = host.Uri.file('/queries/query.sql') as unknown as vscode.Uri;
const configuration: ExtensionConfiguration = {
  keyPatternSources: ['*Sql'], keyPatterns: [], allowAllMultilineStrings: true,
  dialect: 'spark', plainSqlEnabled: true, schemaValidationEnabled: true,
  schemaValidationCompletionOnly: false, schemaFileGlobs: ['*.sql'], udfs: [],
  placeholderSources: [], placeholderPatterns: [], placeholderIssues: [],
  allowPlaceholdersEverywhere: true, format: commentFormat,
};
const services: SqlSchemaService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  host.sourceDocument.getText.mockReturnValue('CREATE TABLE example (id INT);');
});
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});

function createService() {
  const recovery = new host.EventEmitter<{ lane: 'analysis' | 'lexical'; epoch: number }>();
  const worker = {
    buildSchema: vi.fn<SqlService['buildSchema']>(),
    releaseSchema: vi.fn<SqlService['releaseSchema']>(),
    onDidRecover: vi.fn<SqlService['onDidRecover']>(recovery.event),
  };
  const service = new SqlSchemaService(worker as unknown as SqlService);
  services.push(service);
  return { service, worker, recovery };
}

function snapshot(name: string): SchemaSnapshot {
  return {
    tables: [{
      name, normalizedName: name, normalizedLeafName: name, kind: 'table', columns: [],
      source: host.ddlUri.toString(), start: 0, end: 12,
    }],
    issues: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function untilCalled(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (mock.mock.calls.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} worker calls, received ${mock.mock.calls.length}.`);
}

describe('SQL Schema worker lifecycle', () => {
  it('retries an infrastructure failure after its cooldown without changing the Schema generation', async () => {
    const { service, worker } = createService();
    const recovered = snapshot('recovered');
    const retryAfter = Date.now() + 1_000;
    worker.buildSchema.mockRejectedValueOnce(new SqlServiceError('timeout', 'worker startup stalled', {
      phase: 'startup', retryable: true, retryAfter,
    }));
    worker.buildSchema.mockResolvedValueOnce(recovered);

    const failed = await service.getSchema(resource, configuration, true);
    expect(service.getSchemaFailure(failed)).toBeDefined();
    const failedKey = worker.buildSchema.mock.calls[0]![0];
    expect(worker.releaseSchema).toHaveBeenCalledWith(failedKey);
    expect(await service.getSchema(resource, configuration, true)).toBe(failed);
    await vi.advanceTimersByTimeAsync(999);
    expect(await service.getSchema(resource, configuration, true)).toBe(failed);
    expect(worker.buildSchema).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(await service.getSchema(resource, configuration, true)).toBe(recovered);
    expect(service.getSchemaKey(recovered)).toBe(failedKey);
    expect(service.getSchemaFailure(recovered)).toBeUndefined();
    expect(worker.buildSchema).toHaveBeenCalledTimes(2);
  });

  it('retains the last good Schema while a recovered worker rebuilds a failed index', async () => {
    const { service, worker, recovery } = createService();
    const original = snapshot('original');
    const replacement = snapshot('replacement');
    const rebuilt = deferred<SchemaSnapshot>();
    worker.buildSchema.mockResolvedValueOnce(original);
    worker.buildSchema.mockRejectedValueOnce(new SqlServiceError('worker', 'worker connection lost', {
      retryable: true, retryAfter: Date.now() + 1_000,
    }));
    worker.buildSchema.mockReturnValueOnce(rebuilt.promise);
    await service.getSchema(resource, configuration, true);
    const originalKey = service.getSchemaKey(original)!;

    await service.rebuild([{ resource, configuration }]);
    const failed = await service.getSchema(resource, configuration, true);
    expect(failed.tables).toBe(original.tables);
    expect(service.getSchemaKey(failed)).toBe(originalKey);
    const changed = vi.fn();
    const subscription = service.onDidChangeSchema(changed);
    recovery.fire({ lane: 'analysis', epoch: 2 });
    expect(changed).toHaveBeenCalledTimes(1);

    expect(await service.getSchema(resource, configuration)).toBe(original);
    await untilCalled(worker.buildSchema, 3);
    expect(worker.releaseSchema).not.toHaveBeenCalledWith(originalKey);
    const pending = service.getSchema(resource, configuration, true);
    rebuilt.resolve(replacement);
    expect(await pending).toBe(replacement);
    expect(service.getSchemaFailure(replacement)).toBeUndefined();
    expect(worker.releaseSchema.mock.calls.filter(([key]) => key === originalKey)).toHaveLength(1);
    subscription.dispose();
  });

  it('invalidates only failed retryable entries when the analysis worker recovers', async () => {
    const { service, worker, recovery } = createService();
    const successful = snapshot('successful');
    const pendingSnapshot = snapshot('pending');
    const recovered = snapshot('recovered');
    const pendingBuild = deferred<SchemaSnapshot>();
    const stableConfiguration = { ...configuration, udfs: ['stable_udf'] };
    const exhaustedConfiguration = { ...configuration, udfs: ['exhausted_udf'] };
    const recoverableConfiguration = { ...configuration, udfs: ['recoverable_udf'] };
    const pendingConfiguration = { ...configuration, udfs: ['pending_udf'] };
    worker.buildSchema.mockResolvedValueOnce(successful);
    worker.buildSchema.mockRejectedValueOnce(new SqlServiceError('timeout', 'Schema exceeded its execution budget', {
      phase: 'schema',
    }));
    worker.buildSchema.mockRejectedValueOnce(new SqlServiceError('worker', 'worker transport failed', {
      retryable: true, retryAfter: Date.now() + 1_000,
    }));
    worker.buildSchema.mockReturnValueOnce(pendingBuild.promise);
    worker.buildSchema.mockResolvedValueOnce(recovered);
    await service.getSchema(resource, stableConfiguration, true);
    const exhausted = await service.getSchema(resource, exhaustedConfiguration, true);
    const recoverable = await service.getSchema(resource, recoverableConfiguration, true);
    const pending = service.getSchema(resource, pendingConfiguration, true);
    await untilCalled(worker.buildSchema, 4);
    const changed = vi.fn();
    const subscription = service.onDidChangeSchema(changed);

    recovery.fire({ lane: 'lexical', epoch: 2 });
    expect(changed).not.toHaveBeenCalled();
    expect(await service.getSchema(resource, recoverableConfiguration, true)).toBe(recoverable);
    recovery.fire({ lane: 'analysis', epoch: 3 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await service.getSchema(resource, stableConfiguration, true)).toBe(successful);
    expect(await service.getSchema(resource, exhaustedConfiguration, true)).toBe(exhausted);
    const anotherPending = service.getSchema(resource, pendingConfiguration, true);
    expect(worker.buildSchema).toHaveBeenCalledTimes(4);
    expect(await service.getSchema(resource, recoverableConfiguration, true)).toBe(recovered);
    expect(worker.buildSchema).toHaveBeenCalledTimes(5);
    pendingBuild.resolve(pendingSnapshot);
    expect(await pending).toBe(pendingSnapshot);
    expect(await anotherPending).toBe(pendingSnapshot);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await service.getSchema(resource, exhaustedConfiguration, true)).toBe(exhausted);
    expect(worker.buildSchema).toHaveBeenCalledTimes(5);
    changed.mockClear();
    recovery.fire({ lane: 'analysis', epoch: 4 });
    expect(changed).not.toHaveBeenCalled();
    subscription.dispose();
  });

  it('reports the first build failure, caches it for that generation, and retries after a rebuild', async () => {
    const { service, worker } = createService();
    const recovered = snapshot('recovered');
    worker.buildSchema.mockRejectedValueOnce(new SqlServiceError('timeout', 'build exceeded its budget'));
    worker.buildSchema.mockResolvedValueOnce(recovered);

    const failed = await service.getSchema(resource, configuration, true);
    expect(failed.tables).toEqual([]);
    expect(service.getSchemaKey(failed)).toBeUndefined();
    expect(service.getSchemaFailure(failed)).toContain('timed out');
    const failedKey = worker.buildSchema.mock.calls[0]![0];
    expect(worker.releaseSchema).toHaveBeenCalledWith(failedKey);
    expect(await service.getSchema(resource, configuration, true)).toBe(failed);
    expect(worker.buildSchema).toHaveBeenCalledTimes(1);

    await service.rebuild([{ resource, configuration }]);
    expect(await service.getSchema(resource, configuration, true)).toBe(recovered);
    expect(service.getSchemaFailure(recovered)).toBeUndefined();
    expect(service.getSchemaKey(recovered)).not.toBe(failedKey);
    expect(worker.buildSchema).toHaveBeenCalledTimes(2);
  });

  it('retains the last good Schema on failure and replaces it only after a successful new generation', async () => {
    const { service, worker } = createService();
    const original = snapshot('original');
    const recovered = snapshot('recovered');
    worker.buildSchema.mockResolvedValueOnce(original);
    worker.buildSchema.mockRejectedValueOnce(new SqlServiceError('worker', 'worker crashed'));
    worker.buildSchema.mockResolvedValueOnce(recovered);
    await service.getSchema(resource, configuration, true);
    const originalKey = service.getSchemaKey(original)!;
    expect(service.isSchemaCurrent(original)).toBe(true);

    await service.rebuild([{ resource, configuration }]);
    const failed = await service.getSchema(resource, configuration, true);
    expect(failed.tables).toBe(original.tables);
    expect(service.getSchemaKey(failed)).toBe(originalKey);
    expect(service.getSchemaFailure(failed)).toContain('worker crashed');
    expect(service.isSchemaCurrent(failed)).toBe(false);
    expect(worker.releaseSchema).not.toHaveBeenCalledWith(originalKey);

    await service.rebuild([{ resource, configuration }]);
    expect(await service.getSchema(resource, configuration, true)).toBe(recovered);
    expect(service.isSchemaCurrent(recovered)).toBe(true);
    expect(worker.releaseSchema.mock.calls.filter(([key]) => key === originalKey)).toHaveLength(1);
  });

  it('moves an awaiting fresh request to the newest generation when the DDL changes during its build', async () => {
    const { service, worker } = createService();
    const oldBuild = deferred<SchemaSnapshot>();
    const freshBuild = deferred<SchemaSnapshot>();
    const fresh = snapshot('fresh');
    worker.buildSchema.mockReturnValueOnce(oldBuild.promise);
    worker.buildSchema.mockReturnValueOnce(freshBuild.promise);
    const pending = service.getSchema(resource, configuration, true);
    await untilCalled(worker.buildSchema, 1);
    const supersededKey = worker.buildSchema.mock.calls[0]![0];

    host.change.fire({ document: { uri: host.ddlUri } });
    await vi.advanceTimersByTimeAsync(150);
    oldBuild.resolve(snapshot('superseded'));
    await untilCalled(worker.buildSchema, 2);
    expect(worker.buildSchema.mock.calls[1]![0]).not.toBe(supersededKey);
    expect(worker.releaseSchema).toHaveBeenCalledWith(supersededKey);
    freshBuild.resolve(fresh);

    expect(await pending).toBe(fresh);
    expect(await service.getSchema(resource, configuration, true)).toBe(fresh);
    expect(service.getSchemaFailure(fresh)).toBeUndefined();
  });

  it('keeps a shared old worker Schema until every last-good configuration has replaced it', async () => {
    const { service, worker } = createService();
    const alternate = { ...configuration, schemaFileGlobs: ['tables*.sql'] };
    const original = snapshot('original');
    const replacement = snapshot('replacement');
    const build = deferred<SchemaSnapshot>();
    worker.buildSchema.mockResolvedValueOnce(original);
    worker.buildSchema.mockResolvedValueOnce(original);
    worker.buildSchema.mockReturnValueOnce(build.promise);
    worker.buildSchema.mockResolvedValueOnce(replacement);
    await service.getSchema(resource, configuration, true);
    await service.getSchema(resource, alternate, true);
    const originalKey = service.getSchemaKey(original)!;
    expect(worker.buildSchema.mock.calls[1]![0]).toBe(originalKey);
    expect(service.isSchemaCurrent(original)).toBe(true);

    host.change.fire({ document: { uri: host.ddlUri } });
    expect(service.isSchemaCurrent(original)).toBe(false);
    const pending = service.getSchema(resource, configuration, true);
    await untilCalled(worker.buildSchema, 3);
    expect(await service.getSchema(resource, configuration)).toBe(original);
    expect(worker.releaseSchema).not.toHaveBeenCalledWith(originalKey);
    build.resolve(replacement);
    expect(await pending).toBe(replacement);
    expect(service.isSchemaCurrent(original)).toBe(false);
    expect(service.isSchemaCurrent(replacement)).toBe(true);
    expect(worker.releaseSchema).not.toHaveBeenCalledWith(originalKey);

    expect(await service.getSchema(resource, alternate, true)).toBe(replacement);
    expect(worker.releaseSchema.mock.calls.filter(([key]) => key === originalKey)).toHaveLength(1);
    service.clear();
    expect(service.isSchemaCurrent(replacement)).toBe(false);
    expect(worker.releaseSchema).toHaveBeenCalledWith(service.getSchemaKey(replacement));
  });

  it('does not reuse a last-good worker key for changed DDL read by another configuration inside the debounce window', async () => {
    const { service, worker } = createService();
    const alternate = { ...configuration, schemaFileGlobs: ['tables*.sql'] };
    const original = snapshot('original');
    worker.buildSchema.mockResolvedValueOnce(original);
    worker.buildSchema.mockRejectedValueOnce(new SqlServiceError('worker', 'changed DDL build failed'));
    await service.getSchema(resource, configuration, true);
    const originalKey = service.getSchemaKey(original)!;

    host.sourceDocument.getText.mockReturnValue('CREATE TABLE example (changed STRING);');
    host.change.fire({ document: { uri: host.ddlUri } });
    const failed = await service.getSchema(resource, alternate);
    expect(service.getSchemaFailure(failed)).toContain('changed DDL build failed');
    expect(worker.buildSchema.mock.calls[1]![0]).not.toBe(originalKey);
    expect(worker.releaseSchema).not.toHaveBeenCalledWith(originalKey);
    expect(await service.getSchema(resource, configuration)).toBe(original);
  });
});
