import { Worker } from 'node:worker_threads';

import type { SqlFormatConfiguration } from './config';
import type { EditorFormattingOptions } from './sqlFormatting';
import type { SchemaSnapshot, SqlSymbolResolution } from './sqlSchemaCore';
import type { SqlDialect } from './sqlDialect';
import type { SqlToken } from './sqlTypes';
import type {
  SqlAnalysisOptions, SqlAnalysisResult, SqlCancellationToken, SqlCompletionOptions, SqlCompletionResult,
  SqlDocumentSnapshot, SqlJsonWorkerConfiguration, SqlSchemaRegistration, SqlWorkerMessage,
  SqlWorkerOperation, SqlWorkerResult,
} from './sqlWorkerProtocol';

export type {
  SqlAnalysisOptions, SqlAnalysisResult, SqlCancellationToken, SqlCompletionOptions, SqlCompletionResult,
  SqlDocumentSnapshot, SqlJsonWorkerConfiguration,
} from './sqlWorkerProtocol';

export type SqlServiceErrorCode = 'timeout' | 'cancelled' | 'stale' | 'worker';
export type SqlServicePhase = 'startup' | 'schema' | 'operation';
export interface SqlWorkerRecovery { lane: 'analysis' | 'lexical'; epoch: number }
export interface SqlWorkerEvent extends SqlWorkerRecovery {
  event: 'start' | 'ready' | 'dispatch' | 'result' | 'failure' | 'recovered' | 'cancelled';
  phase: SqlServicePhase;
  operation?: SqlWorkerOperation['operation'];
  elapsedMs: number;
  errorCode?: SqlServiceErrorCode;
  retryable?: boolean;
}
export class SqlServiceError extends Error {
  readonly phase: SqlServicePhase;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  constructor(readonly code: SqlServiceErrorCode, message: string,
    details: { phase?: SqlServicePhase; retryable?: boolean; retryAfter?: number } = {}) {
    super(message);
    this.name = 'SqlServiceError';
    this.phase = details.phase ?? 'operation';
    this.retryable = details.retryable ?? false;
    this.retryAfter = details.retryAfter;
  }
}

export interface SqlServiceOptions {
  analysisWorkerPath: string;
  lexicalWorkerPath: string;
  deadlinePolicy?: 'enforce' | 'debug';
  recoveryCooldownMs?: number;
  onWorkerEvent?: (event: SqlWorkerEvent) => void;
  startupTimeoutMs?: number;
  analysisTimeoutMs?: number;
  lexicalTimeoutMs?: number;
  extendedTimeoutMs?: number;
  maxDocuments?: number;
  maxInteractiveResultsPerDocument?: number;
  /** Enables lifecycle tests without loading the parser bundle. */
  workerFactory?: (path: string) => Worker;
}

interface WorkerTask {
  id: number;
  epoch?: number;
  createOperation: () => SqlWorkerOperation;
  timeoutMs: number;
  schemaTimeoutMs: number;
  priority: number;
  operation: SqlWorkerOperation['operation'];
  resolve(value: SqlWorkerResult): void;
  reject(error: SqlServiceError): void;
}

interface TaskHandle {
  promise: Promise<SqlWorkerResult>;
  readonly epoch: number | undefined;
  cancel(error: SqlServiceError): void;
}

/** One serialized CPU lane; the other lane remains available when this one is stopped. */
class WorkerLane {
  private worker: Worker | undefined;
  private ready = false;
  private startupTimer: NodeJS.Timeout | undefined;
  private executionTimer: NodeJS.Timeout | undefined;
  private readonly queue: WorkerTask[] = [];
  private active: WorkerTask | undefined;
  private sequence = 0;
  private disposed = false;
  private cooldownError: SqlServiceError | undefined;
  private needsRecovery = false;
  private phase: SqlServicePhase = 'startup';
  private phaseStartedAt = 0;
  epoch = 0;

  constructor(
    private readonly path: string,
    private readonly startupTimeoutMs: number,
    private readonly factory: (path: string) => Worker,
    private readonly options: {
      name: SqlWorkerRecovery['lane'];
      deadlinePolicy: 'enforce' | 'debug';
      recoveryCooldownMs: number;
      log?: (event: SqlWorkerEvent) => void;
      recovered: (event: SqlWorkerRecovery) => void;
    },
  ) {}

  run(createOperation: () => SqlWorkerOperation, timeoutMs: number, priority: number,
    schemaTimeoutMs: number, operation: SqlWorkerOperation['operation']): TaskHandle {
    let task!: WorkerTask;
    const promise = new Promise<SqlWorkerResult>((resolve, reject) => {
      task = { id: ++this.sequence, createOperation, timeoutMs, schemaTimeoutMs, priority, operation, resolve, reject };
      if (this.disposed) {
        reject(new SqlServiceError('cancelled', 'SQL service has been disposed.'));
        return;
      }
      if (this.cooldownError && Date.now() < this.cooldownError.retryAfter!) {
        reject(this.cooldownError);
        return;
      }
      this.cooldownError = undefined;
      this.queue.push(task);
      this.queue.sort((left, right) => left.priority - right.priority || left.id - right.id);
      this.pump();
    });
    return {
      promise,
      get epoch() { return task.epoch; },
      cancel: (error) => {
        if (this.active === task) {
          this.finish(error, undefined, true);
        } else {
          const index = this.queue.indexOf(task);
          if (index >= 0) { this.queue.splice(index, 1); task.reject(error); }
        }
      },
    };
  }

  clear(error: SqlServiceError): void {
    for (const task of this.queue.splice(0)) task.reject(error);
    if (this.active) { this.active.reject(error); this.active = undefined; }
    this.retireWorker();
    this.cooldownError = undefined;
    this.needsRecovery = false;
  }

  dispose(): void {
    this.disposed = true;
    this.clear(new SqlServiceError('cancelled', 'SQL service has been disposed.'));
  }

  notify(operation: SqlWorkerOperation): void {
    if (!this.worker || !this.ready) return;
    try { this.worker.postMessage({ ...operation, id: 0, epoch: this.epoch }); }
    catch { this.failInfrastructure('worker', 'SQL worker communication failed.'); }
  }

  private pump(): void {
    if (this.active || this.disposed) return;
    this.active = this.queue.shift();
    if (!this.active) { this.worker?.unref(); return; }
    if (this.worker) {
      this.worker.ref();
      if (this.ready) this.dispatch();
      return;
    }
    this.epoch += 1;
    this.phase = 'startup';
    this.phaseStartedAt = Date.now();
    this.log('start');
    try {
      const worker = this.factory(this.path);
      this.worker = worker;
      const epoch = this.epoch;
      worker.on('message', (message: SqlWorkerMessage) => {
        if (this.worker !== worker || this.epoch !== epoch) return;
        if (message.kind === 'ready') {
          if (this.ready) return;
          this.ready = true;
          if (this.startupTimer) clearTimeout(this.startupTimer);
          this.startupTimer = undefined;
          this.log('ready');
          this.dispatch();
        } else if (message.id === this.active?.id && message.epoch === epoch) {
          if (message.kind === 'schemaReady') { this.setExecutionTimer(this.active.timeoutMs, 'operation'); return; }
          if (message.kind === 'result') this.finish(undefined, message.value);
          else this.finish(new SqlServiceError('worker', message.message, { phase: this.phase }));
        }
      });
      worker.on('error', (error) => {
        if (this.worker === worker) this.failInfrastructure('worker', error.message);
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.failInfrastructure('worker', `SQL worker exited with code ${code}.`);
      });
      // Inspector can pause a new worker before its entry point runs. Developer
      // breakpoints must not be treated as a parser exhausting its CPU budget.
      if (this.options.deadlinePolicy === 'enforce') {
        this.startupTimer = setTimeout(() => this.failInfrastructure(
          'timeout', 'SQL worker startup exceeded its time limit.',
        ), this.startupTimeoutMs);
      }
    } catch (error) {
      this.failInfrastructure('worker', error instanceof Error ? error.message : String(error));
    }
  }

  private dispatch(): void {
    if (!this.active || !this.worker || !this.ready) return;
    const task = this.active;
    task.epoch = this.epoch;
    let operation: SqlWorkerOperation;
    try {
      operation = task.createOperation();
    } catch (error) {
      this.finish(error instanceof SqlServiceError ? error
        : new SqlServiceError('worker', error instanceof Error ? error.message : String(error)));
      return;
    }
    const restoringSchema = 'schemaKey' in operation && !!operation.schema;
    this.setExecutionTimer(restoringSchema ? task.schemaTimeoutMs : task.timeoutMs,
      restoringSchema || operation.operation === 'buildSchema' ? 'schema' : 'operation');
    this.log('dispatch');
    try { this.worker.postMessage({ ...operation, id: task.id, epoch: this.epoch }); }
    catch { this.failInfrastructure('worker', 'SQL worker communication failed.'); }
  }

  private setExecutionTimer(timeoutMs: number, phase: SqlServicePhase): void {
    if (this.executionTimer) clearTimeout(this.executionTimer);
    this.executionTimer = undefined;
    this.phase = phase;
    this.phaseStartedAt = Date.now();
    if (this.options.deadlinePolicy === 'debug') return;
    this.executionTimer = setTimeout(() => this.finish(
      new SqlServiceError('timeout', 'SQL analysis exceeded its time limit.', { phase }), undefined, true,
    ), timeoutMs);
  }

  private failInfrastructure(code: 'timeout' | 'worker', message: string): void {
    const error = new SqlServiceError(code, message, {
      phase: this.phase, retryable: true, retryAfter: Date.now() + this.options.recoveryCooldownMs,
    });
    this.cooldownError = error;
    this.needsRecovery = true;
    // One broken lane must not spawn a fresh worker for every queued document.
    for (const task of this.queue.splice(0)) task.reject(error);
    this.finish(error, undefined, true);
  }

  private log(event: SqlWorkerEvent['event'], error?: SqlServiceError): void {
    try {
      this.options.log?.({
        lane: this.options.name, epoch: this.epoch, event, phase: this.phase,
        operation: this.active?.operation, elapsedMs: Math.max(0, Date.now() - this.phaseStartedAt),
        ...(error ? { errorCode: error.code, retryable: error.retryable } : {}),
      });
    } catch { /* Logging must not interrupt worker lifecycle management. */ }
  }

  private finish(error?: SqlServiceError, value?: SqlWorkerResult, retire = false): void {
    if (this.executionTimer) clearTimeout(this.executionTimer);
    this.executionTimer = undefined;
    const task = this.active;
    this.log(error ? error.code === 'cancelled' || error.code === 'stale' ? 'cancelled' : 'failure' : 'result', error);
    this.active = undefined;
    if (retire) this.retireWorker();
    if (task) { if (error) task.reject(error); else task.resolve(value); }
    if (!error && task && this.needsRecovery) {
      this.needsRecovery = false;
      const recovery = { lane: this.options.name, epoch: this.epoch };
      this.log('recovered');
      queueMicrotask(() => {
        if (!this.disposed && this.worker && this.ready && this.epoch === recovery.epoch) {
          this.options.recovered(recovery);
        }
      });
    }
    // Let settled-result and budget-failure caches commit before dispatching
    // the next queued task, which may share the same document budget.
    queueMicrotask(() => this.pump());
  }

  private retireWorker(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.executionTimer) clearTimeout(this.executionTimer);
    this.startupTimer = undefined;
    this.executionTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    if (worker) {
      worker.removeAllListeners();
      worker.on('error', () => undefined);
      void worker.terminate().catch(() => undefined);
    }
  }
}

interface CacheEntry {
  uri?: string;
  schemaKey?: string;
  interactive: boolean;
  handle: TaskHandle;
  consumers: number;
  settled: boolean;
}

interface BudgetFailure {
  uri: string;
  schemaKey?: string;
  error: SqlServiceError;
}

export class SqlService {
  private readonly analysis: WorkerLane;
  private readonly lexical: WorkerLane;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly budgetFailures = new Map<string, BudgetFailure>();
  private readonly documents = new Map<string, number>();
  private readonly schemas = new Map<string, SqlSchemaRegistration>();
  private readonly registeredSchemas = new Map<string, { epoch: number; revision: number }>();
  private readonly recoveryListeners = new Set<(event: SqlWorkerRecovery) => void>();
  private schemaRevision = 0;
  private configurationGeneration = 0;
  private disposed = false;
  private readonly analysisTimeoutMs: number;
  private readonly lexicalTimeoutMs: number;
  private readonly extendedTimeoutMs: number;
  private readonly maxDocuments: number;
  private readonly maxInteractiveResultsPerDocument: number;

  constructor(options: SqlServiceOptions) {
    const factory = options.workerFactory ?? ((path) => new Worker(path, {
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
    }));
    const laneOptions = {
      deadlinePolicy: options.deadlinePolicy ?? 'enforce',
      recoveryCooldownMs: Math.max(0, options.recoveryCooldownMs ?? 1_000),
      log: options.onWorkerEvent,
      recovered: (event: SqlWorkerRecovery) => {
        for (const listener of this.recoveryListeners) {
          try { listener(event); } catch { /* One provider must not prevent the others from recovering. */ }
        }
      },
    };
    this.analysis = new WorkerLane(options.analysisWorkerPath, options.startupTimeoutMs ?? 5_000, factory,
      { ...laneOptions, name: 'analysis' });
    this.lexical = new WorkerLane(options.lexicalWorkerPath, options.startupTimeoutMs ?? 5_000, factory,
      { ...laneOptions, name: 'lexical' });
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? 2_000;
    this.lexicalTimeoutMs = options.lexicalTimeoutMs ?? 2_000;
    this.extendedTimeoutMs = options.extendedTimeoutMs ?? 10_000;
    this.maxDocuments = Math.max(1, options.maxDocuments ?? 32);
    this.maxInteractiveResultsPerDocument = Math.max(1, options.maxInteractiveResultsPerDocument ?? 64);
  }

  get generation(): number { return this.configurationGeneration; }

  onDidRecover(listener: (event: SqlWorkerRecovery) => void): { dispose(): void } {
    if (!this.disposed) this.recoveryListeners.add(listener);
    return { dispose: () => { this.recoveryListeners.delete(listener); } };
  }

  tokens(snapshot: SqlDocumentSnapshot, cancellation?: SqlCancellationToken): Promise<SqlToken[]> {
    return this.documentRequest(snapshot, 'tokens', {}, this.lexical, () => ({ operation: 'tokens', snapshot }),
      this.lexicalTimeoutMs, 0, cancellation);
  }

  analyze(snapshot: SqlDocumentSnapshot, options: SqlAnalysisOptions = {}, cancellation?: SqlCancellationToken): Promise<SqlAnalysisResult> {
    return this.documentRequest(snapshot, 'analyze', this.schemaOptions(options), this.analysis, () => ({
      operation: 'analyze', snapshot, options, ...this.schemaRequest(options.schemaKey),
    }), this.analysisTimeoutMs, 2, cancellation, options.schemaKey);
  }

  completion(snapshot: SqlDocumentSnapshot, offset: number, options: SqlCompletionOptions = {}, cancellation?: SqlCancellationToken): Promise<SqlCompletionResult> {
    return this.documentRequest(snapshot, 'completion', { offset, ...this.schemaOptions(options) }, this.analysis, () => ({
      operation: 'completion', snapshot, offset, options, ...this.schemaRequest(options.schemaKey),
    }), this.analysisTimeoutMs, 0, cancellation, options.schemaKey);
  }

  symbol(snapshot: SqlDocumentSnapshot, offset: number, options: SqlAnalysisOptions = {}, cancellation?: SqlCancellationToken): Promise<SqlSymbolResolution | undefined> {
    return this.documentRequest(snapshot, 'symbol', { offset, ...this.schemaOptions(options) }, this.analysis, () => ({
      operation: 'symbol', snapshot, offset, options, ...this.schemaRequest(options.schemaKey),
    }), this.analysisTimeoutMs, 0, cancellation, options.schemaKey);
  }

  format(snapshot: SqlDocumentSnapshot, format: SqlFormatConfiguration, editor: EditorFormattingOptions, cancellation?: SqlCancellationToken): Promise<string> {
    return this.documentRequest(snapshot, 'format', { format, editor }, this.analysis, () => ({
      operation: 'format', snapshot, format, editor,
    }), this.extendedTimeoutMs, 0, cancellation);
  }

  formatJson(snapshot: { uri: string; version: number; text: string }, configuration: SqlJsonWorkerConfiguration,
    editor: EditorFormattingOptions, cancellation?: SqlCancellationToken): Promise<string> {
    return this.documentRequest({
      ...snapshot, region: 'json-document', dialect: configuration.dialect, placeholderSources: configuration.placeholderSources,
    }, 'formatJson', { configuration, editor }, this.analysis, () => ({
      operation: 'formatJson', snapshot, configuration, editor,
    }), this.extendedTimeoutMs, 0, cancellation);
  }

  buildSchema(key: string, sources: readonly { source: string; text: string }[], dialect: SqlDialect,
    udfs: readonly string[] = []): Promise<SchemaSnapshot> {
    let schema = this.schemas.get(key);
    if (!schema || schema.dialect !== dialect || JSON.stringify(schema.udfs) !== JSON.stringify(udfs)
      || schema.sources.length !== sources.length || schema.sources.some((source, index) => (
        source.source !== sources[index]?.source || source.text !== sources[index]?.text
      ))) {
      schema = { key, sources: sources.map((source) => ({ ...source })), dialect, udfs: [...udfs], revision: ++this.schemaRevision };
      this.schemas.set(key, schema);
    }
    const registration = schema;
    return this.request<SchemaSnapshot>(`schema:${key}:${registration.revision}`, undefined, this.analysis,
      () => ({ operation: 'buildSchema', schema: registration }), this.extendedTimeoutMs, 1, undefined, registration);
  }

  /** Release a replaced Schema after the host has committed its new last-good generation. */
  releaseSchema(key: string): void {
    this.schemas.delete(key);
    this.registeredSchemas.delete(key);
    for (const [failureKey, failure] of this.budgetFailures) {
      if (failure.schemaKey === key) this.budgetFailures.delete(failureKey);
    }
    const error = new SqlServiceError('stale', 'SQL Schema was replaced during analysis.');
    for (const [cacheKey, entry] of this.cache) {
      if (entry.schemaKey !== key) continue;
      this.cache.delete(cacheKey);
      if (!entry.settled) entry.handle.cancel(error);
    }
    this.analysis.notify({ operation: 'forgetSchema', key });
  }

  /** Called on every edit, before the next debounced diagnostic request. */
  updateDocument(uri: string, version: number): void {
    const current = this.documents.get(uri);
    if (current !== undefined && version < current) return;
    if (current !== undefined && current !== version) {
      this.invalidateDocument(uri, new SqlServiceError('stale', 'SQL document changed during analysis.'));
    }
    this.documents.delete(uri);
    this.documents.set(uri, version);
    while (this.documents.size > this.maxDocuments) {
      const oldest = this.documents.keys().next().value as string;
      this.clearDocument(oldest);
    }
  }

  clearDocument(uri: string): void {
    this.invalidateDocument(uri, new SqlServiceError('stale', 'SQL document analysis was invalidated.'));
    this.documents.delete(uri);
  }

  clear(): void {
    this.configurationGeneration += 1;
    const error = new SqlServiceError('stale', 'SQL configuration or Schema changed during analysis.');
    this.cache.clear();
    this.budgetFailures.clear();
    this.documents.clear();
    this.schemas.clear();
    this.registeredSchemas.clear();
    this.analysis.clear(error);
    this.lexical.clear(error);
  }

  dispose(): void {
    this.disposed = true;
    this.recoveryListeners.clear();
    this.cache.clear();
    this.budgetFailures.clear();
    this.documents.clear();
    this.schemas.clear();
    this.registeredSchemas.clear();
    this.analysis.dispose();
    this.lexical.dispose();
  }

  private schemaOptions(options: SqlAnalysisOptions | SqlCompletionOptions): Record<string, unknown> {
    const cacheOptions: Record<string, unknown> = {
      ...options, schemaRevision: options.schemaKey ? this.schemas.get(options.schemaKey)?.revision : undefined,
    };
    // All regions belong to the same immutable document version. Do not duplicate their large literals in cache keys.
    if ('allSqlTexts' in cacheOptions) {
      cacheOptions.allSqlTexts = (options as SqlCompletionOptions).allSqlTexts?.map((text) => text.length);
    }
    return cacheOptions;
  }

  private schemaRequest(key?: string): { schemaKey?: string; schemaRevision?: number; schema?: SqlSchemaRegistration } {
    if (!key) return {};
    const schema = this.schemas.get(key);
    if (!schema) throw new SqlServiceError('worker', 'SQL Schema sources are unavailable.');
    const registered = this.registeredSchemas.get(key);
    return {
      schemaKey: key, schemaRevision: schema.revision,
      schema: registered?.epoch === this.analysis.epoch && registered.revision === schema.revision ? undefined : schema,
    };
  }

  private documentRequest<T>(snapshot: SqlDocumentSnapshot, operation: SqlWorkerOperation['operation'], parameters: unknown, lane: WorkerLane,
    createOperation: () => SqlWorkerOperation, timeoutMs: number, priority: number,
    cancellation?: SqlCancellationToken, schemaKey?: string): Promise<T> {
    if (this.disposed) return Promise.reject(new SqlServiceError('cancelled', 'SQL service has been disposed.'));
    if (cancellation?.isCancellationRequested) return Promise.reject(new SqlServiceError('cancelled', 'SQL request was cancelled.'));
    const current = this.documents.get(snapshot.uri);
    if (current !== undefined && snapshot.version < current) {
      return Promise.reject(new SqlServiceError('stale', 'SQL document version is stale.'));
    }
    this.updateDocument(snapshot.uri, snapshot.version);
    const group = operation === 'tokens' ? 'lexical'
      : operation === 'format' || operation === 'formatJson' ? 'extended' : 'normalAnalysis';
    const failureKey = JSON.stringify({
      uri: snapshot.uri, version: snapshot.version, region: snapshot.region,
      dialect: snapshot.dialect, placeholders: snapshot.placeholderSources, group,
      configuration: group === 'extended' ? parameters : {
        schemaKey, schemaRevision: schemaKey ? this.schemas.get(schemaKey)?.revision : undefined,
        udfs: (parameters as SqlAnalysisOptions).udfs ?? [],
      },
    });
    const failure = this.budgetFailures.get(failureKey);
    if (failure) return Promise.reject(failure.error);
    const key = JSON.stringify({
      uri: snapshot.uri, version: snapshot.version, region: snapshot.region,
      dialect: snapshot.dialect, placeholders: snapshot.placeholderSources, operation, parameters,
    });
    return this.request<T>(key, snapshot.uri, lane, () => {
      // A previous request may exhaust this version's budget while this one waits in the lane.
      const blocked = this.budgetFailures.get(failureKey);
      if (blocked) throw blocked.error;
      return createOperation();
    }, timeoutMs, priority, cancellation,
      schemaKey ? this.schemas.get(schemaKey) : undefined, operation === 'completion' || operation === 'symbol',
      { key: failureKey, uri: snapshot.uri, schemaKey }, operation);
  }

  private request<T>(key: string, uri: string | undefined, lane: WorkerLane, createOperation: () => SqlWorkerOperation,
    timeoutMs: number, priority: number, cancellation?: SqlCancellationToken, schema?: SqlSchemaRegistration,
    interactive = false, failureGroup?: { key: string; uri: string; schemaKey?: string },
    operation: SqlWorkerOperation['operation'] = 'buildSchema'): Promise<T> {
    if (this.disposed) return Promise.reject(new SqlServiceError('cancelled', 'SQL service has been disposed.'));
    let entry = this.cache.get(key);
    if (!entry) {
      entry = {
        uri, schemaKey: schema?.key, interactive,
        handle: lane.run(createOperation, timeoutMs, priority, this.extendedTimeoutMs, operation), consumers: 0, settled: false,
      };
      this.cache.set(key, entry);
      const cached = entry;
      void entry.handle.promise.then(() => {
        cached.settled = true;
        if (schema && cached.handle.epoch !== undefined && this.schemas.get(schema.key)?.revision === schema.revision) {
          this.registeredSchemas.set(schema.key, { epoch: cached.handle.epoch, revision: schema.revision });
        }
        if (uri && interactive) this.pruneInteractive(uri);
      }, (error: unknown) => {
        cached.settled = true;
        if (this.cache.get(key) === cached && error instanceof SqlServiceError) {
          if (error.retryable) this.cache.delete(key);
          else if (failureGroup && error.code === 'timeout') {
            this.budgetFailures.set(failureGroup.key, { uri: failureGroup.uri, schemaKey: failureGroup.schemaKey, error });
          }
        }
        if (uri && interactive) this.pruneInteractive(uri);
      });
    } else {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    const shared = entry;
    shared.consumers += 1;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      let subscription: { dispose(): void } | undefined;
      const finish = (error?: unknown, value?: SqlWorkerResult): void => {
        if (finished) return;
        finished = true;
        subscription?.dispose();
        shared.consumers -= 1;
        if (error) reject(error); else resolve(value as T);
      };
      const cancel = (): void => {
        const error = new SqlServiceError('cancelled', 'SQL request was cancelled.');
        finish(error);
        if (!shared.settled && shared.consumers === 0) {
          if (this.cache.get(key) === shared) this.cache.delete(key);
          shared.handle.cancel(error);
        }
      };
      if (cancellation) {
        subscription = cancellation.onCancellationRequested(cancel);
        if (finished) subscription.dispose();
        else if (cancellation.isCancellationRequested) cancel();
      }
      void shared.handle.promise.then((value) => finish(undefined, value), (error) => finish(error));
    });
  }

  private invalidateDocument(uri: string, error: SqlServiceError): void {
    for (const [key, failure] of this.budgetFailures) {
      if (failure.uri === uri) this.budgetFailures.delete(key);
    }
    for (const [key, entry] of this.cache) {
      if (entry.uri !== uri) continue;
      this.cache.delete(key);
      if (!entry.settled) entry.handle.cancel(error);
    }
  }

  private pruneInteractive(uri: string): void {
    const entries = [...this.cache].filter(([, entry]) => entry.uri === uri && entry.interactive);
    let excess = entries.length - this.maxInteractiveResultsPerDocument;
    for (const [key, entry] of entries) {
      if (excess <= 0) break;
      if (entry.settled) { this.cache.delete(key); excess -= 1; }
    }
  }
}
