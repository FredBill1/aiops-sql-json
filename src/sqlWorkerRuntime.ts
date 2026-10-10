import { parentPort } from 'node:worker_threads';

import type { SqlWorkerMessage, SqlWorkerRequest, SqlWorkerResult } from './sqlWorkerProtocol';

/** Keep third-party parser failures inside the worker and send only data to the host. */
export function runSqlWorker(handler: (request: SqlWorkerRequest) => SqlWorkerResult): void {
  const port = parentPort;
  if (!port) throw new Error('SQL worker must run in a worker thread.');
  port.on('message', (request: SqlWorkerRequest) => {
    let message: SqlWorkerMessage;
    try {
      message = { kind: 'result', id: request.id, epoch: request.epoch, value: handler(request) };
    } catch (error) {
      message = {
        kind: 'error', id: request.id, epoch: request.epoch,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    port.postMessage(message);
  });
  port.postMessage({ kind: 'ready' } satisfies SqlWorkerMessage);
}
