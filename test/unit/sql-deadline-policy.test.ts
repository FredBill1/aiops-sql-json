import { describe, expect, it } from 'vitest';

import {
  resolveSqlDeadlinePolicy,
  serializeSqlWorkerMetadata,
  type SqlExtensionMode,
  type SqlWorkerLogMetadata,
} from '../../src/sqlDeadlinePolicy';

describe('SQL worker deadline policy', () => {
  it('allows inspected development workers to remain paused in the debugger', () => {
    expect(resolveSqlDeadlinePolicy('development', 'ws://127.0.0.1/inspector', undefined)).toBe('debug');
  });

  it('enforces deadlines in a development host without an inspector', () => {
    expect(resolveSqlDeadlinePolicy('development', undefined, undefined)).toBe('enforce');
    expect(resolveSqlDeadlinePolicy('development', '', undefined)).toBe('enforce');
  });

  it.each(['test', 'production'] as const)('enforces deadlines in %s hosts even with an inspector', (mode) => {
    expect(resolveSqlDeadlinePolicy(mode, 'ws://127.0.0.1/inspector', undefined)).toBe('enforce');
  });

  it.each(['development', 'test', 'production'] satisfies SqlExtensionMode[])(
    'honors the production deadline override in %s hosts',
    (mode) => {
      expect(resolveSqlDeadlinePolicy(mode, 'ws://127.0.0.1/inspector', '1')).toBe('enforce');
    },
  );

  it('requires the exact override value', () => {
    expect(resolveSqlDeadlinePolicy('development', 'ws://127.0.0.1/inspector', '0')).toBe('debug');
    expect(resolveSqlDeadlinePolicy('development', 'ws://127.0.0.1/inspector', '')).toBe('debug');
  });
});

describe('SQL worker lifecycle logging', () => {
  it('serializes only the declared metadata even when its input contains private data', () => {
    const event: SqlWorkerLogMetadata & { text: string; source: string; message: string } = {
      lane: 'analysis', epoch: 2, phase: 'startup', event: 'timeout', elapsedMs: 5_000,
      errorCode: 'timeout', retryable: true,
      text: "SELECT 'private payload'", source: 'file:///private/query.sql', message: 'private exception details',
    };
    expect(JSON.parse(serializeSqlWorkerMetadata(event))).toEqual({
      lane: 'analysis', epoch: 2, phase: 'startup', event: 'timeout', elapsedMs: 5_000,
      errorCode: 'timeout', retryable: true,
    });
  });

  it('includes the operation without requiring error metadata on successful work', () => {
    expect(JSON.parse(serializeSqlWorkerMetadata({
      lane: 'lexical', epoch: 1, phase: 'operation', operation: 'tokens', event: 'result', elapsedMs: 12,
    }))).toEqual({
      lane: 'lexical', epoch: 1, phase: 'operation', operation: 'tokens', event: 'result', elapsedMs: 12,
    });
  });
});
