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
const { parentPort } = require('node:worker_threads');
let calls = 0;
const schemas = new Map();
parentPort.on('message', (request) => {
  const text = request.snapshot?.text;
  if (text === 'hang' && request.operation !== 'tokens') { while (true) {} }
  if (text === 'crash') throw new Error('intentional worker crash');
  if (request.schema?.sources.some(source => source.text === 'hang-schema')) { while (true) {} }
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
    else value = {sql:{issues:[],tokens:[{start:0,end:calls,type:'keyword'}]},semantics:[]};
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
    startupTimeoutMs: 1_000, analysisTimeoutMs: 250, lexicalTimeoutMs: 250, extendedTimeoutMs: 500,
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

  it('isolates lexical requests from a blocked analysis and remembers a failed version', async () => {
    const runtime = service({ analysisTimeoutMs: 100 });
    const blocked = runtime.service.analyze(snapshot('hang'));
    const blockedExpectation = expect(blocked).rejects.toMatchObject({ code: 'timeout', phase: 'operation', retryable: false });
    expect((await runtime.service.tokens(snapshot('SELECT 1', 'other.sql')))[0]?.end).toBe(1);
    await blockedExpectation;
    const starts = runtime.starts();
    await expect(runtime.service.analyze(snapshot('hang'))).rejects.toMatchObject({ code: 'timeout' });
    expect(runtime.starts()).toBe(starts);
    expect((await runtime.service.analyze(snapshot('SELECT 1', 'test.sql', 2))).sql.issues).toEqual([]);
    expect(runtime.starts()).toBe(starts + 1);
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

  it('remembers a failed analysis budget across offsets, operations and interactive cache eviction', async () => {
    const runtime = service({ analysisTimeoutMs: 50, maxInteractiveResultsPerDocument: 1 });
    const query = snapshot('hang');
    await expect(runtime.service.symbol(query, 0)).rejects.toMatchObject({ code: 'timeout' });
    const starts = runtime.starts();
    await expect(runtime.service.symbol(query, 1)).rejects.toMatchObject({ code: 'timeout' });
    await expect(runtime.service.completion(query, 2)).rejects.toMatchObject({ code: 'timeout' });
    await expect(runtime.service.analyze(query)).rejects.toMatchObject({ code: 'timeout' });
    expect(runtime.starts()).toBe(starts);
    expect((await runtime.service.tokens(query))[0]?.end).toBe(1);
    expect((await runtime.service.symbol(snapshot('SELECT 1', 'test.sql', 2), 0))?.type).toBe('1');
  });

  it('terminates work when the final subscriber cancels and starts fresh for the next request', async () => {
    const runtime = service();
    const cancellation = new Cancellation();
    const cancelled = runtime.service.analyze(snapshot('hang'), {}, cancellation);
    const observed = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
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

  it('skips queued offsets and operations after their shared document budget fails', async () => {
    const runtime = service({ analysisTimeoutMs: 100 });
    const query = snapshot('hang');
    const results = await Promise.allSettled([
      runtime.service.symbol(query, 0),
      runtime.service.symbol(query, 1),
      runtime.service.completion(query, 2),
      runtime.service.analyze(query),
    ]);
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'timeout' });
    }
    expect(runtime.starts()).toBeLessThanOrEqual(2);
    expect((await runtime.service.analyze(snapshot('SELECT 1', 'healthy.sql'))).sql.issues).toEqual([]);
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
    const runtime = service({ analysisTimeoutMs: 100 });
    const sources = [{ source: 'schema.sql', text: 'CREATE TABLE t (id INT)' }];
    await runtime.service.buildSchema('schema', sources, 'spark', []);
    await expect(runtime.service.analyze(snapshot('hang'))).rejects.toMatchObject({ code: 'timeout' });
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

  it('rejects queued analysis after a transport crash without poisoning their document versions', async () => {
    const runtime = service();
    const results = await Promise.allSettled([
      runtime.service.analyze(snapshot('crash')),
      runtime.service.analyze(snapshot('SELECT 2', 'queued.sql')),
      runtime.service.symbol(snapshot('SELECT 3', 'queued-symbol.sql'), 0),
    ]);
    const failure = results[0]?.status === 'rejected' ? results[0].reason : undefined;
    expect(failure).toMatchObject({ code: 'worker', phase: 'operation', retryable: true });
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toBe(failure);
    }
    expect(runtime.starts()).toBe(1);
    await waitForRetry(failure);
    expect((await runtime.service.analyze(snapshot('SELECT 2', 'queued.sql'))).sql.issues).toEqual([]);
    expect((await runtime.service.symbol(snapshot('SELECT 3', 'queued-symbol.sql'), 0))?.name).toBe('id');
    expect(runtime.starts()).toBe(2);
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

  it('distinguishes a Schema execution timeout from a recoverable startup failure', async () => {
    const runtime = service({ extendedTimeoutMs: 50 });
    await expect(runtime.service.buildSchema('schema', [{ source: 'generated.sql', text: 'hang-schema' }], 'spark'))
      .rejects.toMatchObject({ code: 'timeout', phase: 'schema', retryable: false });
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
});
