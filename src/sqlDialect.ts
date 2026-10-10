export const SQL_DIALECTS = [
  'spark', 'hive', 'flink', 'mysql', 'postgresql', 'trino', 'impala', 'generic',
] as const;

export type SqlDialect = (typeof SQL_DIALECTS)[number];

export function isSqlDialect(value: unknown): value is SqlDialect {
  return typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value);
}
