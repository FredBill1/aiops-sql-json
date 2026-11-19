import { describe, expect, it } from 'vitest';

import { resolveSqlWorkerLimit } from '../../src/sqlWorkerLimit';

const gib = 1024 ** 3;

describe('SQL worker limit', () => {
  it('uses both the available parallelism and the host memory budget', () => {
    expect(resolveSqlWorkerLimit('auto', { parallelism: 16, totalMemory: 31.9 * gib })).toEqual({ mode: 'auto', limit: 7 });
    expect(resolveSqlWorkerLimit('auto', { parallelism: 3, totalMemory: 32 * gib })).toEqual({ mode: 'auto', limit: 1 });
    expect(resolveSqlWorkerLimit('auto', { parallelism: 32, totalMemory: 64 * gib })).toEqual({ mode: 'auto', limit: 16 });
  });

  it('accounts for process memory limits and retains capacity for one worker on small hosts', () => {
    const host = { parallelism: 16, totalMemory: 16 * gib };
    expect(resolveSqlWorkerLimit('auto', { ...host, constrainedMemory: 8 * gib }).limit).toBe(2);
    expect(resolveSqlWorkerLimit('auto', { ...host, constrainedMemory: 32 * gib }).limit).toBe(4);
    expect(resolveSqlWorkerLimit('auto', { ...host, constrainedMemory: 0 }).limit).toBe(4);
    expect(resolveSqlWorkerLimit('auto', { parallelism: 1, totalMemory: gib }).limit).toBe(1);
  });

  it('accepts positive integer overrides and falls back to auto for invalid values', () => {
    const host = { parallelism: 8, totalMemory: 8 * gib };
    for (const limit of [1, 9, Number.MAX_SAFE_INTEGER]) {
      expect(resolveSqlWorkerLimit(limit, host)).toEqual({ mode: 'manual', limit });
    }
    for (const setting of [undefined, null, '9', 0, -2, 1.5, NaN, Infinity]) {
      expect(resolveSqlWorkerLimit(setting, host)).toEqual({ mode: 'auto', limit: 2 });
    }
  });
});
