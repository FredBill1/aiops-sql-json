export type SqlDeadlinePolicy = 'enforce' | 'debug';
export type SqlExtensionMode = 'development' | 'test' | 'production';

/** Debugger pauses are allowed only in an inspected development host. */
export function resolveSqlDeadlinePolicy(
  extensionMode: SqlExtensionMode,
  inspectorUrl: string | undefined,
  enforceTimeouts: string | undefined,
): SqlDeadlinePolicy {
  return extensionMode === 'development' && Boolean(inspectorUrl) && enforceTimeouts !== '1'
    ? 'debug'
    : 'enforce';
}

export interface SqlWorkerLogMetadata {
  lane: 'analysis' | 'lexical';
  epoch: number;
  phase: 'startup' | 'schema' | 'operation';
  operation?: string;
  event: string;
  elapsedMs: number;
  errorCode?: string;
  retryable?: boolean;
}

/** Keep document text, paths, and exception messages out of worker logs. */
export function serializeSqlWorkerMetadata(event: SqlWorkerLogMetadata): string {
  return JSON.stringify({
    lane: event.lane,
    epoch: event.epoch,
    phase: event.phase,
    operation: event.operation,
    event: event.event,
    elapsedMs: event.elapsedMs,
    errorCode: event.errorCode,
    retryable: event.retryable,
  });
}
