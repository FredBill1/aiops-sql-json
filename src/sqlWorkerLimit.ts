import * as os from 'node:os';

const MEMORY_PER_WORKER = 4 * 1024 ** 3;

interface HostResources {
  parallelism: number;
  totalMemory: number;
  constrainedMemory?: number;
}

export function resolveSqlWorkerLimit(setting: unknown, host?: HostResources): {
  mode: 'auto' | 'manual'; limit: number;
} {
  if (typeof setting === 'number' && Number.isInteger(setting) && setting >= 1) {
    return { mode: 'manual', limit: setting };
  }
  const { parallelism, totalMemory, constrainedMemory } = host ?? {
    parallelism: os.availableParallelism?.() ?? os.cpus().length,
    totalMemory: os.totalmem(),
    constrainedMemory: process.constrainedMemory?.(),
  };
  const memory = constrainedMemory && constrainedMemory > 0 ? Math.min(constrainedMemory, totalMemory) : totalMemory;
  const limit = Math.max(1, Math.floor(Math.min(parallelism / 2, memory / MEMORY_PER_WORKER)));
  return { mode: 'auto', limit };
}
