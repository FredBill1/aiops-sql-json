import { Session } from 'node:inspector';
import { Worker } from 'node:worker_threads';

import { expect, it } from 'vitest';

import { SqlService, type SqlDocumentSnapshot } from '../../src/sqlService';

interface WorkerNotification {
  params: { sessionId: string; waitingForDebugger?: boolean; message?: string };
}

const fixture = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (request) => {
  if (request.snapshot.text === "SELECT 'paused';") debugger;
  parentPort.postMessage({kind:'result',id:request.id,epoch:request.epoch,value:[{start:0,end:6,type:'keyword'}]});
});
parentPort.postMessage({kind:'ready'});
`;

function snapshot(text: string): SqlDocumentSnapshot {
  return { uri: `generated-${text}.sql`, version: 1, region: 'plain', text, dialect: 'spark', placeholderSources: [] };
}

function post(session: Session, method: string, parameters: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => session.post(method, parameters, (error) => error ? reject(error) : resolve()));
}

function notification(session: Session, event: string,
  matches: (notification: WorkerNotification) => boolean = () => true): Promise<WorkerNotification> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.removeListener(event, listener);
      reject(new Error(`Inspector did not send ${event}.`));
    }, 2_000);
    const listener = (value: WorkerNotification): void => {
      if (!matches(value)) return;
      clearTimeout(timeout);
      session.removeListener(event, listener);
      resolve(value);
    };
    session.on(event, listener);
  });
}

function workerCommand(session: Session, workerSessionId: string, id: number, method: string): Promise<void> {
  const reply = notification(session, 'NodeWorker.receivedMessageFromWorker', ({ params }) =>
    params.sessionId === workerSessionId && JSON.parse(params.message ?? '{}').id === id);
  return post(session, 'NodeWorker.sendMessageToWorker', {
    sessionId: workerSessionId, message: JSON.stringify({ id, method }),
  }).then(async () => {
    const result = JSON.parse((await reply).params.message ?? '{}');
    if (result.error) throw new Error(result.error.message);
  });
}

it('survives real debugger pauses beyond production startup and operation deadlines', async () => {
  const session = new Session();
  session.connect();
  const workers: Worker[] = [];
  const runtime = new SqlService({
    analysisWorkerPath: 'analysis', lexicalWorkerPath: 'lexical', deadlinePolicy: 'debug',
    workerFactory: () => {
      const worker = new Worker(fixture, { eval: true, execArgv: [] });
      workers.push(worker);
      return worker;
    },
  });
  try {
    await post(session, 'NodeWorker.enable', { waitForDebuggerOnStart: true });
    const attached = notification(session, 'NodeWorker.attachedToWorker');
    let startupSettled = false;
    const pendingStartup = runtime.tokens(snapshot('SELECT 1;'));
    void pendingStartup.then(() => { startupSettled = true; }, () => { startupSettled = true; });
    const worker = (await attached).params;
    expect(worker.waitingForDebugger).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    expect(startupSettled).toBe(false);
    await workerCommand(session, worker.sessionId, 1, 'Runtime.runIfWaitingForDebugger');
    expect(await pendingStartup).toEqual([{ start: 0, end: 6, type: 'keyword' }]);

    await workerCommand(session, worker.sessionId, 2, 'Debugger.enable');
    const paused = notification(session, 'NodeWorker.receivedMessageFromWorker', ({ params }) =>
      params.sessionId === worker.sessionId && JSON.parse(params.message ?? '{}').method === 'Debugger.paused');
    let operationSettled = false;
    const pendingOperation = runtime.tokens(snapshot("SELECT 'paused';"));
    void pendingOperation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
    await paused;
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(operationSettled).toBe(false);
    await workerCommand(session, worker.sessionId, 3, 'Debugger.resume');
    expect(await pendingOperation).toEqual([{ start: 0, end: 6, type: 'keyword' }]);
    expect(workers).toHaveLength(1);
  } finally {
    runtime.dispose();
    await Promise.all(workers.map((worker) => worker.terminate()));
    session.disconnect();
  }
}, 12_000);
