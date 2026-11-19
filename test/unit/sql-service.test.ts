import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it } from 'vitest';

import { SqlService, type SqlCancellationToken, type SqlDocumentSnapshot } from '../../src/sqlService';

class Cancellation implements SqlCancellationToken {
  isCancellationRequested = false;
  private readonly listeners = new Set<() => void>();
  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener();
  }
}

const fixtureWorker = `
const { parentPort, workerData } = require('node:worker_threads');
const waitForGate = (key) => {
  if (workerData?.[key]) Atomics.wait(new Int32Array(workerData[key]), 0, 0);
};
waitForGate('startup');
let calls = 0;
const schemas = new Map();
parentPort.on('message', (request) => {
  const text = request.snapshot?.text;
  if (text === 'hang' && request.operation !== 'tokens') { while (true) {} }
  if (text === 'crash') throw new Error('intentional worker crash');
  if (request.schema?.sources.some(source => source.text === 'hang-schema')) { while (true) {} }
  if (text === 'gated') waitForGate('operation');
  const reply = () => {
    calls += 1;
    if (request.operation === 'forgetSchema') schemas.delete(request.key);
    if (request.schema) schemas.set(request.schema.key, request.schema.revision);
    if (request.schemaKey && schemas.get(request.schemaKey) !== request.schemaRevision) {
      parentPort.postMessage({kind:'error',id:request.id,epoch:request.epoch,message:'missing resident schema'});
      return;
    }
    let value;
    if (request.operation === 'tokens') value = [{start:0,end:calls,type:'keyword'}];
    else if (request.operation === 'buildSchema') value = {tables:[],issues:[]};
    else if (request.operation === 'symbol') value = {reference:{start:0,end:1},kind:'column',name:'id',type:String(calls),definitions:[]};
    else value = {sql:{issues:[],tokens:[{start:request.freshParse ? 1 : 0,end:calls,type:'keyword'}]},semantics:[]};
    parentPort.postMessage({kind:'result',id:request.id,epoch:request.epoch,value});
  };
  if (text === 'wrong-epoch') {
    parentPort.postMessage({kind:'result',id:request.id,epoch:request.epoch-1,value:[{start:0,end:999,type:'keyword'}]});
  }
  if (text === 'delay' || text === 'wrong-epoch') setTimeout(reply, 80);
  else reply();
});
parentPort.postMessage({kind:'ready'});
`;

const services: SqlService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });

function service(options: Partial<ConstructorParameters<typeof SqlService>[0]> = {}): { service: SqlService; starts: () => number } {
  let starts = 0;
  const { workerFactory, ...configuration } = options;
  const result = new SqlService({
    analysisWorkerPath: 'analysis', lexicalWorkerPath: 'lexical',
    startupTimeoutMs: 1_000, lexicalTimeoutMs: 250,
    recoveryCooldownMs: 50,
    workerFactory: (path) => { starts += 1; return workerFactory?.(path) ?? new Worker(fixtureWorker, { eval: true }); },
    ...configuration,
  });
  services.push(result);
  return { service: result, starts: () => starts };
}

async function waitForRetry(error: { retryAfter?: number }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, (error.retryAfter ?? Date.now()) - Date.now()) + 10));
}

function snapshot(text = 'SELECT 1', uri = 'test.sql', version = 1, region = 'plain'): SqlDocumentSnapshot {
  return { text, uri, version, region, dialect: 'spark', placeholderSources: [] };
}

function gate(): { buffer: SharedArrayBuffer; release(): void } {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  return { buffer, release: () => { Atomics.store(view, 0, 1); Atomics.notify(view, 0); } };
}

function signal(): { promise: Promise<void>; fire(): void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => { fire = resolve; });
  return { promise, fire };
}

function gatedParse(runtime: SqlService, uri: string) {
  const started = signal();
  const result = runtime.analyze(snapshot('gated', uri), {}, { onWorkerStart: started.fire });
  return { started: started.promise, result };
}

describe('SQL worker service lifecycle', () => {
  it('starts lazily and shares both in-flight and completed results', async () => {
    const runtime = service();
    expect(runtime.starts()).toBe(0);
    const first = runtime.service.tokens(snapshot('delay'));
    const second = runtime.service.tokens(snapshot('delay'));
    expect(await first).toEqual(await second);
    expect((await runtime.service.tokens(snapshot('delay')))[0]?.end).toBe(1);
    expect(runtime.starts()).toBe(1);
  });

  it('keeps an independent document, Schema build, lexer and host responsive during a busy parse', async () => {
    const dispatched = signal();
    const runtime = service({ onWorkerEvent: (event) => {
      if (event.operation === 'analyze' && event.event === 'dispatch') dispatched.fire();
    } });
    const cancellation = new Cancellation();
    const blocked = runtime.service.analyze(snapshot('hang'), {}, { cancellation });
    const observed = expect(blocked).rejects.toMatchObject({ code: 'cancelled' });
    await dispatched.promise;
    const sameDocument = new Cancellation();
    const queued = runtime.service.symbol(snapshot('hang'), 0, {}, { cancellation: sameDocument });
    const observedQueued = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    const [tokens, analysis, schema] = await Promise.all([
      runtime.service.tokens(snapshot('hang')),
      runtime.service.analyze(snapshot('SELECT 1', 'other.sql')),
      runtime.service.buildSchema('ddl', [{ source: 'schema.sql', text: 'CREATE TABLE t (id int)' }], 'spark'),
    ]);
    expect(tokens[0]?.end).toBe(1);
    expect(analysis.sql.issues).toEqual([]);
    expect(schema.tables).toEqual([]);
    expect(runtime.starts()).toBe(3);
    sameDocument.cancel();
    cancellation.cancel();
    await Promise.all([observed, observedQueued]);
  });

  it('does not cancel shared work when only one subscriber cancels', async () => {
    const runtime = service();
    const cancellation = new Cancellation();
    const cancelled = runtime.service.tokens(snapshot('delay'), cancellation);
    const observed = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    const remaining = runtime.service.tokens(snapshot('delay'));
    cancellation.cancel();
    await observed;
    expect((await remaining)[0]?.end).toBe(1);
    expect(runtime.starts()).toBe(1);
  });

  it('keeps slow parser startup and execution pending until the worker can finish', async () => {
    const startup = gate();
    const operation = gate();
    const allocated = signal();
    const dispatched = signal();
    const runtime = service({
      startupTimeoutMs: 20, lexicalTimeoutMs: 20,
      workerFactory: () => new Worker(fixtureWorker, { eval: true, workerData: {
        startup: startup.buffer, operation: operation.buffer,
      } }),
      onWorkerEvent: (event) => { if (event.event === 'dispatch') dispatched.fire(); },
    });
    const request = runtime.service.analyze(snapshot('gated'), {}, { onWorkerStart: allocated.fire });
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    await allocated.promise;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    startup.release();
    await dispatched.promise;
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    expect(settled).toBe(false);
    operation.release();
    expect((await request).sql.issues).toEqual([]);
  });

  it('terminates work when the final subscriber cancels and starts fresh for the next request', async () => {
    const runtime = service();
    const cancellation = new Cancellation();
    const started = signal();
    const cancelled = runtime.service.analyze(snapshot('hang'), {}, { cancellation, onWorkerStart: started.fire });
    const observed = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    await started.promise;
    cancellation.cancel();
    await observed;
    await runtime.service.analyze(snapshot('SELECT 1', 'next.sql'));
    expect(runtime.starts()).toBe(2);
  });

  it('invalidates an old request immediately on edit and rejects stale snapshots', async () => {
    const runtime = service();
    const old = runtime.service.tokens(snapshot('delay'));
    const observed = expect(old).rejects.toMatchObject({ code: 'stale' });
    runtime.service.updateDocument('test.sql', 2);
    await observed;
    await expect(runtime.service.tokens(snapshot())).rejects.toMatchObject({ code: 'stale' });
    expect((await runtime.service.tokens(snapshot('SELECT 2', 'test.sql', 2)))[0]?.end).toBe(1);
  });

  it('distinguishes regions and placeholder configuration, and evicts the least recently used document', async () => {
    const runtime = service({ maxDocuments: 2 });
    expect((await runtime.service.tokens(snapshot()))[0]?.end).toBe(1);
    expect((await runtime.service.tokens(snapshot('SELECT 1', 'test.sql', 1, 'other')))[0]?.end).toBe(2);
    expect((await runtime.service.tokens({ ...snapshot(), placeholderSources: ['\\$\\w+'] }))[0]?.end).toBe(3);
    await runtime.service.tokens(snapshot('SELECT 1', 'second.sql'));
    await runtime.service.tokens(snapshot()); // Refresh first document's LRU position.
    await runtime.service.tokens(snapshot('SELECT 1', 'third.sql'));
    expect((await runtime.service.tokens(snapshot('SELECT 1', 'second.sql')))[0]?.end).toBe(6);
  });

  it('ignores a reply from the wrong worker epoch', async () => {
    const runtime = service();
    expect((await runtime.service.tokens(snapshot('wrong-epoch')))[0]?.end).toBe(1);
  });

  it('allows queued cancellation and never replaces a worker before it exits', async () => {
    let liveWorkers = 0;
    let peakWorkers = 0;
    const runtime = service({ workerFactory: () => {
      const worker = new Worker(fixtureWorker, { eval: true });
      peakWorkers = Math.max(peakWorkers, ++liveWorkers);
      worker.once('exit', () => { liveWorkers -= 1; });
      return worker;
    } });
    const first = signal();
    const second = signal();
    const firstCancel = new Cancellation();
    const secondCancel = new Cancellation();
    const blocked = Promise.allSettled([
      runtime.service.analyze(snapshot('hang', 'first.sql'), {}, { cancellation: firstCancel, onWorkerStart: first.fire }),
      runtime.service.analyze(snapshot('hang', 'second.sql'), {}, { cancellation: secondCancel, onWorkerStart: second.fire }),
    ]);
    await Promise.all([first.promise, second.promise]);
    const queuedCancel = new Cancellation();
    const queued = runtime.service.analyze(snapshot('SELECT 3', 'cancelled.sql'), {}, { cancellation: queuedCancel });
    const observed = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    const next = runtime.service.analyze(snapshot('SELECT 4', 'next.sql'));
    queuedCancel.cancel();
    firstCancel.cancel();
    expect((await next).sql.issues).toEqual([]);
    secondCancel.cancel();
    await observed;
    expect(await blocked).toMatchObject([{ status: 'rejected' }, { status: 'rejected' }]);
    expect(peakWorkers).toBe(2);
  });

  it('grows a busy pool from two to four and keeps requests for the same document serial', async () => {
    const hold = gate();
    const runtime = service({ workerFactory: () => new Worker(fixtureWorker, {
      eval: true, workerData: { operation: hold.buffer },
    }) });
    const first = [gatedParse(runtime.service, 'first.sql'), gatedParse(runtime.service, 'second.sql')];
    await Promise.all(first.map((task) => task.started));
    let sameDocumentStarted = false;
    const sameDocument = runtime.service.analyze(snapshot('SELECT 1', 'first.sql', 1, 'another-region'), {}, {
      onWorkerStart() { sameDocumentStarted = true; },
    });
    const waiting = [gatedParse(runtime.service, 'third.sql'), gatedParse(runtime.service, 'fourth.sql')];
    const results = Promise.allSettled([...first, ...waiting].map((task) => task.result).concat(sameDocument));
    await Promise.resolve();
    expect(runtime.starts()).toBe(2);

    runtime.service.setAnalysisWorkerLimit(4);
    await Promise.all(waiting.map((task) => task.started));
    expect(runtime.starts()).toBe(4);
    expect(sameDocumentStarted).toBe(false);

    hold.release();
    expect((await results).map((result) => result.status)).toEqual(Array(5).fill('fulfilled'));
    expect(sameDocumentStarted).toBe(true);
  });

  it('accepts large limits and allocates only the lanes needed for queued work', async () => {
    const hold = gate();
    const runtime = service({ analysisWorkerLimit: Number.MAX_SAFE_INTEGER, workerFactory: () => new Worker(fixtureWorker, {
      eval: true, workerData: { operation: hold.buffer },
    }) });
    expect(runtime.starts()).toBe(0);
    const active = Array.from({ length: 9 }, (_, index) => gatedParse(runtime.service, `parallel-${index}.sql`));
    const results = Promise.allSettled(active.map((task) => task.result));
    await Promise.all(active.map((task) => task.started));
    expect(runtime.starts()).toBe(9);
    hold.release();
    expect((await results).map((result) => result.status)).toEqual(Array(9).fill('fulfilled'));
  });

  it('shrinks a busy pool from four to two after tasks finish and exiting workers release their slots', async () => {
    const holds = [gate(), gate(), gate(), gate()] as const;
    const firstRetiring = signal();
    const firstMayExit = signal();
    const secondExited = signal();
    let created = 0;
    const live = new Set<Worker>();
    const runtime = service({ analysisWorkerLimit: 4, workerFactory: () => {
      const index = created++;
      const worker = new Worker(fixtureWorker, { eval: true, workerData: { operation: holds[index]!.buffer } });
      live.add(worker);
      worker.once('exit', () => {
        live.delete(worker);
        if (index === 1) secondExited.fire();
      });
      if (index === 0) {
        const terminate = worker.terminate.bind(worker);
        worker.terminate = async () => {
          firstRetiring.fire();
          await firstMayExit.promise;
          return terminate();
        };
      }
      return worker;
    } });
    const active = holds.map((_, index) => gatedParse(runtime.service, `busy-${index}.sql`));
    const results = Promise.allSettled(active.map((task) => task.result));
    try {
      await Promise.all(active.map((task) => task.started));
      runtime.service.setAnalysisWorkerLimit(2);
      const cancellation = new Cancellation();
      const cancelled = runtime.service.analyze(snapshot('SELECT 1', 'cancelled.sql'), {}, { cancellation });
      const observed = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
      cancellation.cancel();
      await observed;

      let liveAtDispatch: number | undefined;
      const next = runtime.service.analyze(snapshot('SELECT 1', 'waiting.sql'), {}, {
        onWorkerStart() { liveAtDispatch = live.size; },
      });
      const queuedResult = Promise.allSettled([next]);
      holds[0].release();
      await firstRetiring.promise;
      holds[1].release();
      await secondExited.promise;
      holds[2].release();
      await active[2]!.result;
      expect(live.size).toBe(3);
      expect(liveAtDispatch).toBeUndefined();

      firstMayExit.fire();
      expect((await queuedResult)[0]?.status).toBe('fulfilled');
      expect(liveAtDispatch).toBe(2);
      expect(runtime.starts()).toBe(4);
      holds[3].release();
      expect((await results).map((result) => result.status)).toEqual(Array(4).fill('fulfilled'));
      expect(runtime.service.generation).toBe(0);
      expect(await runtime.service.analyze(snapshot('gated', 'busy-0.sql'))).toBe(await active[0]!.result);
    } finally {
      firstMayExit.fire();
    }
  });

  it('grows during shrinkage without reusing an exiting slot before the worker has stopped', async () => {
    const firstHold = gate();
    const secondHold = gate();
    const retiring = signal();
    const mayExit = signal();
    let created = 0;
    let live = 0;
    let peak = 0;
    const runtime = service({ workerFactory: () => {
      const index = created++;
      const worker = new Worker(fixtureWorker, {
        eval: true, workerData: { operation: (index === 0 ? firstHold : secondHold).buffer },
      });
      peak = Math.max(peak, ++live);
      worker.once('exit', () => { live -= 1; });
      if (index === 0) {
        const terminate = worker.terminate.bind(worker);
        worker.terminate = async () => {
          retiring.fire();
          await mayExit.promise;
          return terminate();
        };
      }
      return worker;
    } });
    const first = gatedParse(runtime.service, 'first.sql');
    const second = gatedParse(runtime.service, 'second.sql');
    const results = Promise.allSettled([first.result, second.result]);
    try {
      await Promise.all([first.started, second.started]);
      runtime.service.setAnalysisWorkerLimit(1);
      firstHold.release();
      await retiring.promise;

      runtime.service.setAnalysisWorkerLimit(2);
      const next = runtime.service.analyze(snapshot('SELECT 1', 'waiting.sql'));
      const queuedResult = Promise.allSettled([next]);
      await Promise.resolve();
      expect(runtime.starts()).toBe(2);
      mayExit.fire();
      expect((await queuedResult)[0]?.status).toBe('fulfilled');
      expect(runtime.starts()).toBe(3);
      expect(peak).toBe(2);
      secondHold.release();
      expect((await results).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      mayExit.fire();
    }
  });

  it('bounds per-document interactive results without breaking in-flight sharing', async () => {
    const runtime = service({ maxInteractiveResultsPerDocument: 2 });
    expect((await runtime.service.symbol(snapshot(), 0))?.type).toBe('1');
    expect((await runtime.service.symbol(snapshot(), 1))?.type).toBe('2');
    expect((await runtime.service.symbol(snapshot(), 0))?.type).toBe('1');
    expect((await runtime.service.symbol(snapshot(), 2))?.type).toBe('3');
    expect((await runtime.service.symbol(snapshot(), 1))?.type).toBe('4');
    const first = runtime.service.symbol(snapshot('delay', 'pending.sql'), 0);
    const shared = runtime.service.symbol(snapshot('delay', 'pending.sql'), 0);
    runtime.service.symbol(snapshot('delay', 'pending.sql'), 1).catch(() => undefined);
    expect(await first).toEqual(await shared);
  });

  it('restores resident Schema after a worker restart even when buildSchema has a cached display snapshot', async () => {
    const runtime = service();
    const sources = [{ source: 'schema.sql', text: 'CREATE TABLE t (id INT)' }];
    await runtime.service.buildSchema('schema', sources, 'spark', []);
    const started = signal();
    const cancellation = new Cancellation();
    const blocked = runtime.service.analyze(snapshot('hang'), {}, { cancellation, onWorkerStart: started.fire });
    const observed = expect(blocked).rejects.toMatchObject({ code: 'cancelled' });
    await started.promise;
    cancellation.cancel();
    await observed;
    await runtime.service.buildSchema('schema', sources, 'spark', []);
    expect((await runtime.service.analyze(snapshot('SELECT id FROM t', 'query.sql'), {
      schemaKey: 'schema', validateSchema: true,
    })).semantics).toEqual([]);
  });

  it('recovers after an unexpected worker crash', async () => {
    const runtime = service();
    const failure = await runtime.service.analyze(snapshot('crash')).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'worker', phase: 'operation', retryable: true });
    await waitForRetry(failure as { retryAfter?: number });
    expect((await runtime.service.analyze(snapshot('SELECT 1', 'healthy.sql'))).sql.issues).toEqual([]);
    expect(runtime.starts()).toBe(2);
  });

  it('releases old Schema sources, resident handles and related cached results', async () => {
    const runtime = service();
    const sources = [{ source: 'schema.sql', text: 'CREATE TABLE t (id INT)' }];
    await runtime.service.buildSchema('schema', sources, 'spark');
    const query = snapshot('SELECT id FROM t');
    await runtime.service.analyze(query, { schemaKey: 'schema' });
    runtime.service.releaseSchema('schema');
    await expect(runtime.service.analyze(query, { schemaKey: 'schema' })).rejects.toMatchObject({ code: 'worker' });
    await runtime.service.buildSchema('schema', sources, 'spark');
    expect((await runtime.service.analyze(query, { schemaKey: 'schema' })).sql.issues).toEqual([]);
  });

  it('shares a startup failure with queued requests and retries the same versions after cooldown', async () => {
    let attempts = 0;
    const runtime = service({
      startupTimeoutMs: 250,
      workerFactory: () => new Worker(++attempts === 1 ? 'setInterval(() => {}, 1000)' : fixtureWorker, { eval: true }),
    });
    const results = await Promise.allSettled([
      runtime.service.tokens(snapshot()),
      runtime.service.tokens(snapshot('SELECT 2', 'second.sql')),
      runtime.service.tokens(snapshot('SELECT 3', 'third.sql')),
    ]);
    const failure = results[0]?.status === 'rejected' ? results[0].reason : undefined;
    expect(failure).toMatchObject({ code: 'timeout', phase: 'startup', retryable: true });
    expect(failure.retryAfter).toBeGreaterThan(Date.now());
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toBe(failure);
    }
    await expect(runtime.service.tokens(snapshot())).rejects.toBe(failure);
    await expect(runtime.service.tokens(snapshot('SELECT 4', 'new.sql'))).rejects.toBe(failure);
    expect(runtime.starts()).toBe(1);
    await waitForRetry(failure);
    expect((await runtime.service.tokens(snapshot()))[0]?.end).toBe(1);
    expect((await runtime.service.tokens(snapshot('SELECT 2', 'second.sql')))[0]?.end).toBe(2);
    expect(runtime.starts()).toBe(2);
  });

  it('reports a recovered lane once its replacement worker succeeds and allows listeners to dispose', async () => {
    const runtime = service();
    const recovered: { lane: string; epoch: number }[] = [];
    const subscription = runtime.service.onDidRecover((event) => recovered.push(event));
    const failure = await runtime.service.analyze(snapshot('crash')).catch((error: unknown) => error);
    expect(recovered).toEqual([]);
    await waitForRetry(failure as { retryAfter?: number });
    await runtime.service.analyze(snapshot('SELECT 1', 'healthy.sql'));
    expect(recovered).toEqual([{ lane: 'analysis', epoch: 2 }]);
    await runtime.service.analyze(snapshot('SELECT 2', 'another.sql'));
    expect(recovered).toHaveLength(1);
    subscription.dispose();
    const nextFailure = await runtime.service.analyze(snapshot('crash', 'crash-again.sql')).catch((error: unknown) => error);
    await waitForRetry(nextFailure as { retryAfter?: number });
    await runtime.service.analyze(snapshot('SELECT 3', 'recovered-again.sql'));
    expect(recovered).toHaveLength(1);
  });

  it('backs off queued work when both workers crash and retries the same document versions', async () => {
    const runtime = service({ recoveryCooldownMs: 500 });
    const first = signal();
    const second = signal();
    const blocked = Promise.allSettled([
      runtime.service.analyze(snapshot('crash'), {}, { onWorkerStart: first.fire }),
      runtime.service.analyze(snapshot('crash', 'another.sql'), {}, { onWorkerStart: second.fire }),
    ]);
    await Promise.all([first.promise, second.promise]);
    const results = await Promise.allSettled([
      runtime.service.symbol(snapshot('SELECT 3', 'queued-symbol.sql'), 0),
    ]);
    const failure = results[0]?.status === 'rejected' ? results[0].reason : undefined;
    expect(failure).toMatchObject({ code: 'worker', phase: 'operation', retryable: true });
    for (const result of await blocked) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'worker', retryable: true });
    }
    expect(runtime.starts()).toBe(2);
    await waitForRetry(failure);
    expect((await runtime.service.analyze(snapshot('SELECT 2', 'queued.sql'))).sql.issues).toEqual([]);
    expect((await runtime.service.symbol(snapshot('SELECT 3', 'queued-symbol.sql'), 0))?.name).toBe('id');
    expect(runtime.starts()).toBe(3);
  });

  it('classifies worker construction errors as retryable startup failures', async () => {
    let attempts = 0;
    const runtime = service({
      workerFactory: () => {
        if (++attempts === 1) throw new Error('intentional construction failure');
        return new Worker(fixtureWorker, { eval: true });
      },
    });
    const failure = await runtime.service.tokens(snapshot()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'worker', phase: 'startup', retryable: true });
    await expect(runtime.service.tokens(snapshot())).rejects.toBe(failure);
    await waitForRetry(failure as { retryAfter?: number });
    expect((await runtime.service.tokens(snapshot()))[0]?.end).toBe(1);
  });

  it('can cancel an active Schema build and retry the same registration', async () => {
    const started = signal();
    const cancellation = new Cancellation();
    const runtime = service({ onWorkerEvent: (event) => {
      if (event.event === 'dispatch' && event.phase === 'schema') started.fire();
    } });
    const build = runtime.service.buildSchema('schema', [{ source: 'generated.sql', text: 'hang-schema' }], 'spark', [], { cancellation });
    const observed = expect(build).rejects.toMatchObject({ code: 'cancelled' });
    await started.promise;
    cancellation.cancel();
    await observed;
    expect(await runtime.service.buildSchema('schema', [{ source: 'generated.sql', text: 'CREATE TABLE t (id int)' }], 'spark'))
      .toEqual({ tables: [], issues: [] });
  });

  it('keeps startup and operation deadlines disabled under the debug policy', async () => {
    const runtime = service({
      deadlinePolicy: 'debug', startupTimeoutMs: 10, lexicalTimeoutMs: 10,
      workerFactory: () => new Worker(fixtureWorker.replace("parentPort.postMessage({kind:'ready'});", "setTimeout(() => parentPort.postMessage({kind:'ready'}), 80);"), { eval: true }),
    });
    expect((await runtime.service.tokens(snapshot('delay')))[0]?.end).toBe(1);
  });

  it('can cancel a debug request while its worker is waiting to start', async () => {
    let attempts = 0;
    const runtime = service({
      deadlinePolicy: 'debug',
      workerFactory: () => new Worker(++attempts === 1 ? 'setInterval(() => {}, 1000)' : fixtureWorker, { eval: true }),
    });
    const cancellation = new Cancellation();
    const pending = runtime.service.tokens(snapshot(), cancellation);
    const observed = expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    await Promise.resolve();
    cancellation.cancel();
    await observed;
    expect((await runtime.service.tokens(snapshot('SELECT 2', 'next.sql')))[0]?.end).toBe(1);
    expect(runtime.starts()).toBe(2);
  });

  it('rejects stale and disposed debug requests while execution deadlines are disabled', async () => {
    const runtime = service({ deadlinePolicy: 'debug' });
    await runtime.service.analyze(snapshot('SELECT 1', 'warmup.sql'));
    const stale = runtime.service.analyze(snapshot('hang'));
    const observedStale = expect(stale).rejects.toMatchObject({ code: 'stale' });
    runtime.service.updateDocument('test.sql', 2);
    await observedStale;
    const pending = runtime.service.analyze(snapshot('hang', 'test.sql', 2));
    const observedDisposed = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    runtime.service.dispose();
    await observedDisposed;
    await expect(runtime.service.tokens(snapshot('SELECT 3', 'next.sql'))).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('settles pending and future requests when disposed', async () => {
    const runtime = service();
    const pending = runtime.service.tokens(snapshot('delay'));
    const observed = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    runtime.service.dispose();
    await observed;
    await expect(runtime.service.tokens(snapshot())).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('clears completed caches so a document can be analyzed again', async () => {
    const runtime = service();
    await runtime.service.tokens(snapshot());
    runtime.service.clearDocument('test.sql');
    expect((await runtime.service.tokens(snapshot()))[0]?.end).toBe(2);
    runtime.service.clear();
    expect(runtime.service.generation).toBe(1);
    expect((await runtime.service.tokens(snapshot()))[0]?.end).toBe(1);
  });

  it('forces a new parse of completed regions at the same version and retains the lexical cache', async () => {
    const runtime = service();
    const first = snapshot('SELECT 1', 'test.sql.json', 1, 'region:3');
    const second = snapshot('SELECT 2', 'test.sql.json', 1, 'region:24');
    const original = await runtime.service.analyze(first);
    await runtime.service.analyze(second);
    await runtime.service.tokens(first);
    runtime.service.invalidateDocumentParsing(first.uri);
    const fresh = await runtime.service.analyze(first, {}, { freshParse: true });
    expect(original.sql.tokens[0]).toMatchObject({ start: 0, end: 1 });
    expect(fresh.sql.tokens[0]).toMatchObject({ start: 1, end: 3 });
    expect((await runtime.service.analyze(second, {}, { freshParse: true })).sql.tokens[0]).toMatchObject({ start: 1, end: 4 });
    expect(await runtime.service.analyze(first)).toEqual(fresh);
    expect((await runtime.service.tokens(first))[0]?.end).toBe(1);
  });
});
