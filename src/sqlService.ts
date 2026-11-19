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
  analysisWorkerLimit?: number;
  lexicalWorkerPath: string;
  deadlinePolicy?: 'enforce' | 'debug';
  recoveryCooldownMs?: number;
  onWorkerEvent?: (event: SqlWorkerEvent) => void;
  startupTimeoutMs?: number;
  lexicalTimeoutMs?: number;
  maxDocuments?: number;
  maxInteractiveResultsPerDocument?: number;
  /** Enables lifecycle tests without loading the parser bundle. */
  workerFactory?: (path: string) => Worker;
}

export interface SqlParseRequest {
  cancellation?: SqlCancellationToken;
  onWorkerStart?(): void;
  freshParse?: boolean;
}

interface WorkerTask {
  id: number;
  group: string;
  schema?: SqlSchemaRegistration;
  createOperation: (lane: WorkerLane) => SqlWorkerOperation;
  onWorkerStart?: () => void;
  priority: number;
  operation: SqlWorkerOperation['operation'];
  lane?: WorkerLane;
  resolve(value: SqlWorkerResult): void;
  reject(error: SqlServiceError): void;
}

interface TaskHandle {
  promise: Promise<SqlWorkerResult>;
  cancel(error: SqlServiceError): void;
}

interface WorkerLaneOptions {
  name: SqlWorkerRecovery['lane'];
  path: string;
  factory: (path: string) => Worker;
  recoveryCooldownMs: number;
  deadlines?: { startupMs: number; executionMs: number };
  log?: (event: SqlWorkerEvent) => void;
  nextEpoch(): number;
  onInfrastructureFailure(): void;
  onSuccess(event: SqlWorkerEvent): void;
  onAvailable(): void;
}

class WorkerLane {
  private worker: Worker | undefined;
  private retiring: Worker | undefined;
  private ready = false;
  private timer: NodeJS.Timeout | undefined;
  private active: WorkerTask | undefined;
  private readonly registeredSchemas = new Map<string, number>();
  private cooldownError: SqlServiceError | undefined;
  private phase: SqlServicePhase = 'startup';
  private phaseStartedAt = 0;
  private epoch = 0;

  constructor(private readonly options: WorkerLaneOptions) {}

  get busyGroup(): string | undefined { return this.active?.group ?? this.retiringGroup; }
  private retiringGroup: string | undefined;

  get retryError(): SqlServiceError | undefined {
    return this.cooldownError && Date.now() < this.cooldownError.retryAfter! ? this.cooldownError : undefined;
  }

  get idle(): boolean { return !this.active && !this.retiring && !this.retryError; }
  get warm(): boolean { return this.ready; }
  get exiting(): boolean { return this.retiring !== undefined; }

  retireIfInactive(): boolean {
    if (this.active) return false;
    this.retireWorker();
    return true;
  }

  hasSchema(schema: SqlSchemaRegistration): boolean {
    return this.registeredSchemas.get(schema.key) === schema.revision;
  }

  cancel(task: WorkerTask, error: SqlServiceError): void {
    if (this.active === task) this.finish(error, undefined, true);
  }

  clear(error: SqlServiceError): void {
    this.cooldownError = undefined;
    if (this.active) this.finish(error, undefined, true);
    else this.retireWorker();
  }

  forgetSchema(key: string): void {
    this.registeredSchemas.delete(key);
    if (!this.worker || !this.ready) return;
    try { this.worker.postMessage({ operation: 'forgetSchema', key, id: 0, epoch: this.epoch }); }
    catch { this.failInfrastructure('worker', 'SQL worker communication failed.'); }
  }

  start(task: WorkerTask): void {
    this.active = task;
    task.lane = this;
    this.cooldownError = undefined;
    try { task.onWorkerStart?.(); } catch { /* Progress reporting must not interrupt parsing. */ }
    if (this.active !== task) return;
    if (this.worker) {
      this.worker.ref();
      this.dispatch();
      return;
    }
    this.epoch = this.options.nextEpoch();
    this.phase = 'startup';
    this.phaseStartedAt = Date.now();
    this.log('start');
    try {
      const worker = this.options.factory(this.options.path);
      this.worker = worker;
      const epoch = this.epoch;
      worker.on('message', (message: SqlWorkerMessage) => {
        if (this.worker !== worker || this.epoch !== epoch) return;
        if (message.kind === 'ready') {
          if (this.ready) return;
          this.ready = true;
          this.clearTimer();
          this.log('ready');
          this.dispatch();
        } else if (message.id === this.active?.id && message.epoch === epoch) {
          if (message.kind === 'schemaReady') {
            this.recordSchema(this.active);
            this.phase = 'operation';
            this.phaseStartedAt = Date.now();
          } else if (message.kind === 'result') {
            this.recordSchema(this.active);
            this.finish(undefined, message.value);
          } else {
            this.finish(new SqlServiceError('worker', message.message, { phase: this.phase }));
          }
        }
      });
      worker.on('error', (error) => {
        if (this.worker === worker) this.failInfrastructure('worker', error.message);
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.failInfrastructure('worker', `SQL worker exited with code ${code}.`);
      });
      if (this.options.deadlines) {
        this.timer = setTimeout(() => this.failInfrastructure(
          'timeout', 'SQL worker startup exceeded its time limit.',
        ), this.options.deadlines.startupMs);
      }
    } catch (error) {
      this.failInfrastructure('worker', error instanceof Error ? error.message : String(error));
    }
  }

  private dispatch(): void {
    if (!this.active || !this.worker || !this.ready) return;
    const task = this.active;
    let operation: SqlWorkerOperation;
    try {
      operation = task.createOperation(this);
    } catch (error) {
      this.finish(error instanceof SqlServiceError ? error
        : new SqlServiceError('worker', error instanceof Error ? error.message : String(error)));
      return;
    }
    this.phase = 'schema' in operation && operation.schema ? 'schema' : 'operation';
    this.phaseStartedAt = Date.now();
    if (this.options.deadlines) {
      this.timer = setTimeout(() => this.finish(new SqlServiceError(
        'timeout', 'SQL tokenization exceeded its time limit.', { phase: 'operation' },
      ), undefined, true), this.options.deadlines.executionMs);
    }
    this.log('dispatch');
    try { this.worker.postMessage({ ...operation, id: task.id, epoch: this.epoch }); }
    catch { this.failInfrastructure('worker', 'SQL worker communication failed.'); }
  }

  private recordSchema(task: WorkerTask): void {
    if (task.schema) this.registeredSchemas.set(task.schema.key, task.schema.revision);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private failInfrastructure(code: 'timeout' | 'worker', message: string): void {
    const error = new SqlServiceError(code, message, {
      phase: this.phase, retryable: true, retryAfter: Date.now() + this.options.recoveryCooldownMs,
    });
    this.cooldownError = error;
    this.options.onInfrastructureFailure();
    this.finish(error, undefined, true);
  }

  private log(event: SqlWorkerEvent['event'], error?: SqlServiceError): SqlWorkerEvent {
    const metadata: SqlWorkerEvent = {
      lane: this.options.name, epoch: this.epoch, event, phase: this.phase,
      operation: this.active?.operation, elapsedMs: Math.max(0, Date.now() - this.phaseStartedAt),
      ...(error ? { errorCode: error.code, retryable: error.retryable } : {}),
    };
    try { this.options.log?.(metadata); } catch { /* Logging must not interrupt parsing. */ }
    return metadata;
  }

  private finish(error?: SqlServiceError, value?: SqlWorkerResult, retire = false): void {
    this.clearTimer();
    const task = this.active;
    const event = this.log(error ? error.code === 'cancelled' || error.code === 'stale' ? 'cancelled' : 'failure' : 'result', error);
    this.active = undefined;
    if (retire) this.retireWorker(task?.group);
    else this.worker?.unref();
    if (task) {
      if (error) task.reject(error);
      else {
        task.resolve(value);
        this.options.onSuccess(event);
      }
    }
    this.options.onAvailable();
  }

  private retireWorker(group?: string): void {
    this.clearTimer();
    this.registeredSchemas.clear();
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    if (!worker) return;
    this.retiring = worker;
    this.retiringGroup = group;
    const retired = (): void => {
      if (this.retiring !== worker) return;
      this.retiring = undefined;
      this.retiringGroup = undefined;
      this.options.onAvailable();
    };
    worker.once('exit', retired);
    void worker.terminate().then(retired, () => undefined);
  }
}

class WorkerPool {
  private readonly lanes = new Set<WorkerLane>();
  private readonly draining = new Set<WorkerLane>();
  private readonly queue: WorkerTask[] = [];
  private readonly laneOptions: WorkerLaneOptions;
  private sequence = 0;
  private epoch = 0;
  private needsRecovery = false;
  private pumpScheduled = false;
  private disposed = false;

  constructor(private limit: number, options: Omit<WorkerLaneOptions, 'nextEpoch' | 'onInfrastructureFailure' | 'onSuccess' | 'onAvailable'>,
    recovered: (event: SqlWorkerRecovery) => void) {
    this.laneOptions = {
      ...options,
      nextEpoch: () => ++this.epoch,
      onInfrastructureFailure: () => { this.needsRecovery = true; },
      onSuccess: (event) => {
        if (!this.needsRecovery) return;
        this.needsRecovery = false;
        queueMicrotask(() => {
          if (this.disposed) return;
          try { options.log?.({ ...event, event: 'recovered' }); } catch { /* Logging must not prevent recovery. */ }
          recovered({ lane: event.lane, epoch: event.epoch });
        });
      },
      onAvailable: () => this.schedulePump(),
    };
  }

  setLimit(limit: number): void {
    if (this.limit === limit) return;
    this.limit = limit;
    this.schedulePump();
  }

  run(options: Omit<WorkerTask, 'id' | 'lane' | 'resolve' | 'reject'>): TaskHandle {
    let task!: WorkerTask;
    const promise = new Promise<SqlWorkerResult>((resolve, reject) => {
      task = { ...options, id: ++this.sequence, resolve, reject };
      this.queue.push(task);
      this.schedulePump();
    });
    return {
      promise,
      cancel: (error) => {
        if (task.lane) task.lane.cancel(task, error);
        else {
          const index = this.queue.indexOf(task);
          if (index >= 0) { this.queue.splice(index, 1); task.reject(error); }
        }
      },
    };
  }

  forgetSchema(key: string): void {
    for (const lane of this.lanes) lane.forgetSchema(key);
  }

  clear(error: SqlServiceError): void {
    for (const task of this.queue.splice(0)) task.reject(error);
    for (const lane of this.lanes) lane.clear(error);
    this.needsRecovery = false;
  }

  dispose(): void {
    this.disposed = true;
    this.clear(new SqlServiceError('cancelled', 'SQL service has been disposed.'));
  }

  private schedulePump(): void {
    if (this.disposed || this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private createLane(): WorkerLane {
    const lane = new WorkerLane(this.laneOptions);
    this.lanes.add(lane);
    return lane;
  }

  private trimLanes(): void {
    for (const lane of this.draining) {
      if (lane.exiting) continue;
      this.draining.delete(lane);
      this.lanes.delete(lane);
    }
    let excess = this.lanes.size - this.draining.size - this.limit;
    if (excess <= 0) return;
    // Prefer cold lanes over warm ones that may already hold a Schema index.
    const candidates = [...this.lanes].filter((lane) => !this.draining.has(lane))
      .sort((left, right) => Number(left.warm) - Number(right.warm));
    for (const lane of candidates) {
      if (!lane.retireIfInactive()) continue;
      if (lane.exiting) this.draining.add(lane);
      else this.lanes.delete(lane);
      if (--excess === 0) break;
    }
  }

  private pump(): void {
    if (this.disposed) return;
    this.trimLanes();
    if (this.queue.length === 0 || this.lanes.size > this.limit) return;
    this.queue.sort((left, right) => left.priority - right.priority || left.id - right.id);
    const busyGroups = new Set([...this.lanes].map((lane) => lane.busyGroup));
    while (this.queue.length && this.lanes.size <= this.limit) {
      const idle = [...this.lanes].filter((lane) => lane.idle);
      if (!idle.length && this.lanes.size === this.limit) break;
      const taskIndex = this.queue.findIndex((task) => !busyGroups.has(task.group));
      if (taskIndex < 0) break;
      const [task] = this.queue.splice(taskIndex, 1) as [WorkerTask];
      const lane = idle.find((lane) => task.schema && lane.hasSchema(task.schema))
        ?? idle.find((lane) => lane.warm) ?? idle[0] ?? this.createLane();
      lane.start(task);
      busyGroups.add(lane.busyGroup);
    }
    if (!this.queue.length || this.lanes.size !== this.limit || this.draining.size) return;
    const failures = [...this.lanes].map((lane) => lane.retryError);
    // Once every lane is cooling down, fail queued work once instead of spinning up a worker per request.
    if (failures.every((error) => error !== undefined)) {
      const error = failures.reduce((first, next) => first.retryAfter! <= next.retryAfter! ? first : next);
      for (const task of this.queue.splice(0)) task.reject(error);
    }
  }
}

interface CacheEntry {
  uri?: string;
  schemaKey?: string;
  operation: SqlWorkerOperation['operation'];
  interactive: boolean;
  handle: TaskHandle;
  consumers: number;
  settled: boolean;
  started: boolean;
  startListeners: Set<() => void>;
}

export class SqlService {
  private readonly analysis: WorkerPool;
  private readonly lexical: WorkerPool;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly documents = new Map<string, number>();
  private readonly schemas = new Map<string, SqlSchemaRegistration>();
  private readonly recoveryListeners = new Set<(event: SqlWorkerRecovery) => void>();
  private schemaRevision = 0;
  private configurationGeneration = 0;
  private disposed = false;
  private readonly maxDocuments: number;
  private readonly maxInteractiveResultsPerDocument: number;

  constructor(options: SqlServiceOptions) {
    const factory = options.workerFactory ?? ((path) => new Worker(path, {
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
    }));
    const laneOptions = {
      factory,
      recoveryCooldownMs: Math.max(0, options.recoveryCooldownMs ?? 1_000),
      log: options.onWorkerEvent,
    };
    const recovered = (event: SqlWorkerRecovery): void => {
      for (const listener of this.recoveryListeners) {
        try { listener(event); } catch { /* One provider must not prevent the others from recovering. */ }
      }
    };
    this.analysis = new WorkerPool(options.analysisWorkerLimit ?? 2, {
      ...laneOptions, name: 'analysis', path: options.analysisWorkerPath,
    }, recovered);
    this.lexical = new WorkerPool(1, {
      ...laneOptions, name: 'lexical', path: options.lexicalWorkerPath,
      deadlines: options.deadlinePolicy === 'debug' ? undefined : {
        startupMs: options.startupTimeoutMs ?? 5_000,
        executionMs: options.lexicalTimeoutMs ?? 2_000,
      },
    }, recovered);
    this.maxDocuments = Math.max(1, options.maxDocuments ?? 32);
    this.maxInteractiveResultsPerDocument = Math.max(1, options.maxInteractiveResultsPerDocument ?? 64);
  }

  get generation(): number { return this.configurationGeneration; }

  setAnalysisWorkerLimit(limit: number): void {
    this.analysis.setLimit(limit);
  }

  onDidRecover(listener: (event: SqlWorkerRecovery) => void): { dispose(): void } {
    if (!this.disposed) this.recoveryListeners.add(listener);
    return { dispose: () => { this.recoveryListeners.delete(listener); } };
  }

  tokens(snapshot: SqlDocumentSnapshot, cancellation?: SqlCancellationToken): Promise<SqlToken[]> {
    return this.documentRequest(snapshot, 'tokens', {}, () => ({ operation: 'tokens', snapshot }), { cancellation });
  }

  analyze(snapshot: SqlDocumentSnapshot, options: SqlAnalysisOptions = {}, request?: SqlParseRequest): Promise<SqlAnalysisResult> {
    const freshParse = request?.freshParse;
    return this.documentRequest(snapshot, 'analyze', this.schemaOptions(options), (lane) => ({
      operation: 'analyze', snapshot, options, freshParse, ...this.schemaRequest(options.schemaKey, lane),
    }), request, options.schemaKey);
  }

  completion(snapshot: SqlDocumentSnapshot, offset: number, options: SqlCompletionOptions = {}, request?: SqlParseRequest): Promise<SqlCompletionResult> {
    return this.documentRequest(snapshot, 'completion', { offset, ...this.schemaOptions(options) }, (lane) => ({
      operation: 'completion', snapshot, offset, options, ...this.schemaRequest(options.schemaKey, lane),
    }), request, options.schemaKey);
  }

  symbol(snapshot: SqlDocumentSnapshot, offset: number, options: SqlAnalysisOptions = {}, request?: SqlParseRequest): Promise<SqlSymbolResolution | undefined> {
    return this.documentRequest(snapshot, 'symbol', { offset, ...this.schemaOptions(options) }, (lane) => ({
      operation: 'symbol', snapshot, offset, options, ...this.schemaRequest(options.schemaKey, lane),
    }), request, options.schemaKey);
  }

  format(snapshot: SqlDocumentSnapshot, format: SqlFormatConfiguration, editor: EditorFormattingOptions, request?: SqlParseRequest): Promise<string> {
    return this.documentRequest(snapshot, 'format', { format, editor }, () => ({
      operation: 'format', snapshot, format, editor,
    }), request);
  }

  formatJson(snapshot: { uri: string; version: number; text: string }, configuration: SqlJsonWorkerConfiguration,
    editor: EditorFormattingOptions, request?: SqlParseRequest): Promise<string> {
    return this.documentRequest({
      ...snapshot, region: 'json-document', dialect: configuration.dialect, placeholderSources: configuration.placeholderSources,
    }, 'formatJson', { configuration, editor }, () => ({
      operation: 'formatJson', snapshot, configuration, editor,
    }), request);
  }

  buildSchema(key: string, sources: readonly { source: string; text: string }[], dialect: SqlDialect,
    udfs: readonly string[] = [], request?: SqlParseRequest): Promise<SchemaSnapshot> {
    if (this.disposed || request?.cancellation?.isCancellationRequested) {
      return Promise.reject(new SqlServiceError('cancelled', 'SQL Schema request was cancelled.'));
    }
    let schema = this.schemas.get(key);
    if (!schema || schema.dialect !== dialect || JSON.stringify(schema.udfs) !== JSON.stringify(udfs)
      || schema.sources.length !== sources.length || schema.sources.some((source, index) => (
        source.source !== sources[index]?.source || source.text !== sources[index]?.text
      ))) {
      if (schema) this.releaseSchema(key);
      schema = { key, sources: sources.map((source) => ({ ...source })), dialect, udfs: [...udfs], revision: ++this.schemaRevision };
      this.schemas.set(key, schema);
    }
    const registration = schema;
    return this.request<SchemaSnapshot>(`schema:${key}:${registration.revision}`, this.analysis, {
      group: `schema:${key}`, operation: 'buildSchema', priority: 1, schema: registration,
      createOperation: () => ({ operation: 'buildSchema', schema: registration }), onWorkerStart: request?.onWorkerStart,
    }, request?.cancellation);
  }

  /** Release a replaced Schema after the host has committed its new last-good generation. */
  releaseSchema(key: string): void {
    this.schemas.delete(key);
    const error = new SqlServiceError('stale', 'SQL Schema was replaced during analysis.');
    for (const [cacheKey, entry] of this.cache) {
      if (entry.schemaKey !== key) continue;
      this.cache.delete(cacheKey);
      if (!entry.settled) entry.handle.cancel(error);
    }
    this.analysis.forgetSchema(key);
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
    this.pruneDocuments(uri);
  }

  invalidateDocumentParsing(uri: string): void {
    this.invalidateDocument(uri, new SqlServiceError('stale', 'SQL document analysis was restarted.'), true);
  }

  clearDocument(uri: string): void {
    this.invalidateDocument(uri, new SqlServiceError('stale', 'SQL document analysis was invalidated.'));
    this.documents.delete(uri);
  }

  clear(): void {
    this.configurationGeneration += 1;
    const error = new SqlServiceError('stale', 'SQL configuration or Schema changed during analysis.');
    this.cache.clear();
    this.documents.clear();
    this.schemas.clear();
    this.analysis.clear(error);
    this.lexical.clear(error);
  }

  dispose(): void {
    this.disposed = true;
    this.recoveryListeners.clear();
    this.cache.clear();
    this.documents.clear();
    this.schemas.clear();
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

  private schemaRequest(key: string | undefined, lane: WorkerLane): {
    schemaKey?: string; schemaRevision?: number; schema?: SqlSchemaRegistration;
  } {
    if (!key) return {};
    const schema = this.schemas.get(key);
    if (!schema) throw new SqlServiceError('worker', 'SQL Schema sources are unavailable.');
    return {
      schemaKey: key, schemaRevision: schema.revision,
      schema: lane.hasSchema(schema) ? undefined : schema,
    };
  }

  private documentRequest<T>(snapshot: SqlDocumentSnapshot, operation: SqlWorkerOperation['operation'], parameters: unknown,
    createOperation: WorkerTask['createOperation'], request?: SqlParseRequest, schemaKey?: string): Promise<T> {
    const cancellation = request?.cancellation;
    if (this.disposed) return Promise.reject(new SqlServiceError('cancelled', 'SQL service has been disposed.'));
    if (cancellation?.isCancellationRequested) return Promise.reject(new SqlServiceError('cancelled', 'SQL request was cancelled.'));
    const current = this.documents.get(snapshot.uri);
    if (current !== undefined && snapshot.version < current) {
      return Promise.reject(new SqlServiceError('stale', 'SQL document version is stale.'));
    }
    this.updateDocument(snapshot.uri, snapshot.version);
    const key = JSON.stringify({
      uri: snapshot.uri, version: snapshot.version, region: snapshot.region,
      dialect: snapshot.dialect, placeholders: snapshot.placeholderSources, operation, parameters,
    });
    return this.request<T>(key, operation === 'tokens' ? this.lexical : this.analysis, {
      group: `document:${snapshot.uri}`, operation, priority: operation === 'analyze' ? 2 : 0, createOperation,
      onWorkerStart: request?.onWorkerStart, schema: schemaKey ? this.schemas.get(schemaKey) : undefined,
    }, cancellation, snapshot.uri);
  }

  private request<T>(key: string, pool: WorkerPool, task: Parameters<WorkerPool['run']>[0],
    cancellation?: SqlCancellationToken, uri?: string): Promise<T> {
    const { operation, schema, onWorkerStart } = task;
    const interactive = operation === 'completion' || operation === 'symbol';
    let entry = this.cache.get(key);
    if (!entry) {
      const handle = pool.run({ ...task, onWorkerStart: () => {
        cached.started = true;
        for (const listener of cached.startListeners) listener();
        cached.startListeners.clear();
      } });
      const cached: CacheEntry = {
        uri, schemaKey: schema?.key, operation, interactive, handle, consumers: 0, settled: false,
        started: false, startListeners: new Set(),
      };
      entry = cached;
      this.cache.set(key, cached);
      void handle.promise.then(() => {
        cached.settled = true;
        if (uri && interactive) this.pruneInteractive(uri);
        this.pruneDocuments(uri);
      }, (error: unknown) => {
        cached.settled = true;
        if (this.cache.get(key) === cached && error instanceof SqlServiceError && error.retryable) this.cache.delete(key);
        if (uri && interactive) this.pruneInteractive(uri);
        this.pruneDocuments(uri);
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
        if (onWorkerStart) shared.startListeners.delete(reportStart);
        shared.consumers -= 1;
        if (error) reject(error); else resolve(value as T);
      };
      const reportStart = (): void => {
        try { onWorkerStart?.(); } catch { /* Progress reporting must not interrupt parsing. */ }
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
      if (!finished && !shared.settled && onWorkerStart) {
        if (shared.started) reportStart();
        else shared.startListeners.add(reportStart);
      }
      void shared.handle.promise.then((value) => finish(undefined, value), (error) => finish(error));
    });
  }

  private invalidateDocument(uri: string, error: SqlServiceError, parsingOnly = false): void {
    for (const [key, entry] of this.cache) {
      if (entry.uri !== uri || (parsingOnly && entry.operation === 'tokens')) continue;
      this.cache.delete(key);
      if (!entry.settled) entry.handle.cancel(error);
    }
  }

  private pruneDocuments(keep?: string): void {
    if (this.documents.size <= this.maxDocuments) return;
    const pending = new Set([...this.cache.values()].filter((entry) => !entry.settled).map((entry) => entry.uri));
    for (const uri of this.documents.keys()) {
      if (this.documents.size <= this.maxDocuments) break;
      if (uri !== keep && !pending.has(uri)) this.clearDocument(uri);
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
