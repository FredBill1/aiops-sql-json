import { describe, expect, it } from 'vitest';

import { analyzeSql, SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  getSqlSymbolAtOffset,
  parseDdlSchema,
  type SchemaSnapshot,
  type SqlSymbolResolution,
  type SqlTypeFamily,
} from '../../src/sqlSchemaCore';

interface ScalarTypeCase {
  dialect: SqlDialect;
  name: string;
  expression: string;
  expectedFamily: Exclude<SqlTypeFamily, 'complex' | 'unknown'>;
}

interface ComplexTypeCase {
  dialect: SqlDialect;
  name: string;
  expression: string;
  expectedElementFamily: Exclude<SqlTypeFamily, 'complex' | 'unknown'>;
}

interface CreateQueryNavigationCase {
  dialect: SqlDialect;
  name: string;
  sql: string;
  offset: (sql: string) => number;
  expectedKind: SqlSymbolResolution['kind'];
  expectedFamily?: Exclude<SqlTypeFamily, 'complex' | 'unknown'>;
  expectedDefinitionSource?: 'ddl' | 'local';
  expectedFunctionCategory?: SqlSymbolResolution['functionCategory'];
}

const ddlByDialect: Record<SqlDialect, string> = {
  spark: 'CREATE TABLE test (a DOUBLE, b STRING, ts TIMESTAMP, payload STRUCT<x: INT>);',
  hive: 'CREATE TABLE test (a DOUBLE, b STRING, ts TIMESTAMP, payload STRUCT<x: INT>);',
  flink: "CREATE TABLE test (a DOUBLE, b STRING, ts TIMESTAMP(3), payload ROW<x INT>) WITH ('connector'='values');",
  mysql: 'CREATE TABLE test (a DOUBLE, b VARCHAR(100), ts DATETIME, payload JSON);',
  postgresql: 'CREATE TABLE test (a DOUBLE PRECISION, b TEXT, ts TIMESTAMP, payload JSONB);',
  trino: 'CREATE TABLE test (a DOUBLE, b VARCHAR, ts TIMESTAMP, payload ROW(x INTEGER));',
  impala: 'CREATE TABLE test (a DOUBLE, b STRING, ts TIMESTAMP, payload STRUCT<x: INT>);',
  generic: 'CREATE TABLE test (a DOUBLE, b VARCHAR(100), ts TIMESTAMP, payload STRUCT<x: INT>);',
};

const snapshots = new Map<SqlDialect, SchemaSnapshot>();

function schemaFor(dialect: SqlDialect): SchemaSnapshot {
  const cached = snapshots.get(dialect);
  if (cached) return cached;
  const parsed = parseDdlSchema(ddlByDialect[dialect], dialect, `file:///${dialect}-source.sql`);
  expect(parsed.issues, `${dialect} fixture DDL`).toEqual([]);
  const snapshot = createSchemaSnapshot([parsed]);
  expect(snapshot.issues, `${dialect} fixture snapshot`).toEqual([]);
  snapshots.set(dialect, snapshot);
  return snapshot;
}

function expectValidSyntax(sql: string, dialect: SqlDialect): void {
  expect(analyzeSql(sql, dialect, []).issues.map((issue) => issue.message)).toEqual([]);
}

function projectionSymbol(expression: string, dialect: SqlDialect): SqlSymbolResolution | undefined {
  const sql = `SELECT ${expression} AS inferred_result FROM test`;
  expectValidSyntax(sql, dialect);
  return getSqlSymbolAtOffset(sql, sql.indexOf('inferred_result'), dialect, [], schemaFor(dialect));
}

function expectScalarFamily(
  symbol: SqlSymbolResolution | undefined,
  family: Exclude<SqlTypeFamily, 'complex' | 'unknown'>,
): void {
  expect(symbol).toBeDefined();
  expect(symbol?.dataType).toEqual(expect.objectContaining({ kind: 'scalar', family }));
}

function expectArrayElementFamily(
  symbol: SqlSymbolResolution | undefined,
  family: Exclude<SqlTypeFamily, 'complex' | 'unknown'>,
): void {
  expect(symbol).toBeDefined();
  expect(symbol?.dataType).toEqual(expect.objectContaining({
    kind: 'array',
    elementType: expect.objectContaining({ kind: 'scalar', family }),
  }));
}

const windowTypeCases: ScalarTypeCase[] = SQL_DIALECTS.flatMap((dialect) => [
  {
    dialect,
    name: 'MAX analytic result preserves its argument type',
    expression: 'MAX(a) OVER (PARTITION BY b)',
    expectedFamily: 'number',
  },
  {
    dialect,
    name: 'ROW_NUMBER analytic result is numeric',
    expression: 'ROW_NUMBER() OVER (PARTITION BY b ORDER BY a)',
    expectedFamily: 'number',
  },
  {
    dialect,
    name: 'LEAD analytic result preserves its argument type',
    expression: 'LEAD(a) OVER (PARTITION BY b ORDER BY a)',
    expectedFamily: 'number',
  },
  {
    dialect,
    name: 'COUNT analytic result is numeric',
    expression: 'COUNT(*) OVER (PARTITION BY b)',
    expectedFamily: 'number',
  },
]);

const commonWrapperTypeCases: ScalarTypeCase[] = SQL_DIALECTS.flatMap((dialect) => [
  {
    dialect,
    name: 'unary minus preserves a numeric column type',
    expression: '-a',
    expectedFamily: 'number',
  },
  {
    dialect,
    name: 'unary minus infers a negative numeric literal',
    expression: '-1',
    expectedFamily: 'number',
  },
  {
    dialect,
    name: 'LIKE is boolean',
    expression: "b LIKE '%needle%'",
    expectedFamily: 'boolean',
  },
  {
    dialect,
    name: 'a scalar aggregate subquery exposes its scalar type',
    expression: '(SELECT MAX(nested.a) FROM test AS nested)',
    expectedFamily: 'number',
  },
  {
    dialect,
    name: 'DISTINCT does not erase an aggregate result type',
    expression: 'MAX(DISTINCT a)',
    expectedFamily: 'number',
  },
]);

const concatDialects: readonly SqlDialect[] = ['spark', 'flink', 'postgresql', 'trino', 'generic'];
const distinctPredicateDialects: readonly SqlDialect[] = ['spark', 'flink', 'postgresql', 'trino', 'generic'];

const portableOperatorTypeCases: ScalarTypeCase[] = [
  ...concatDialects.map((dialect): ScalarTypeCase => ({
    dialect,
    name: 'concatenation operator returns text',
    expression: 'b || b',
    expectedFamily: 'string',
  })),
  ...distinctPredicateDialects.map((dialect): ScalarTypeCase => ({
    dialect,
    name: 'IS DISTINCT FROM is boolean',
    expression: 'a IS DISTINCT FROM a',
    expectedFamily: 'boolean',
  })),
];

const dialectSpecificScalarCases: ScalarTypeCase[] = [
  { dialect: 'spark', name: 'null-safe equality is boolean', expression: 'a <=> a', expectedFamily: 'boolean' },
  { dialect: 'spark', name: 'bitwise AND is numeric', expression: 'CAST(a AS BIGINT) & 1', expectedFamily: 'number' },
  { dialect: 'hive', name: 'RLIKE is boolean', expression: "b RLIKE '^x'", expectedFamily: 'boolean' },
  { dialect: 'hive', name: 'null-safe equality is boolean', expression: 'a <=> a', expectedFamily: 'boolean' },
  { dialect: 'hive', name: 'bitwise AND is numeric', expression: 'CAST(a AS BIGINT) & 1', expectedFamily: 'number' },
  { dialect: 'flink', name: 'SIMILAR TO is boolean', expression: "b SIMILAR TO 'x%'", expectedFamily: 'boolean' },
  { dialect: 'mysql', name: 'null-safe equality is boolean', expression: 'a <=> a', expectedFamily: 'boolean' },
  { dialect: 'mysql', name: 'bitwise AND is numeric', expression: 'CAST(a AS SIGNED) & 1', expectedFamily: 'number' },
  { dialect: 'mysql', name: 'DISTINCT GROUP_CONCAT remains text', expression: 'GROUP_CONCAT(DISTINCT b)', expectedFamily: 'string' },
  { dialect: 'postgresql', name: 'ILIKE is boolean', expression: "b ILIKE 'x%'", expectedFamily: 'boolean' },
  { dialect: 'postgresql', name: 'bitwise AND is numeric', expression: 'CAST(a AS BIGINT) & 1', expectedFamily: 'number' },
  {
    dialect: 'postgresql',
    name: 'ordered STRING_AGG remains text',
    expression: "STRING_AGG(b, ',' ORDER BY a)",
    expectedFamily: 'string',
  },
  { dialect: 'impala', name: 'null-safe equality is boolean', expression: 'a <=> a', expectedFamily: 'boolean' },
  { dialect: 'impala', name: 'bitwise AND is numeric', expression: 'CAST(a AS BIGINT) & 1', expectedFamily: 'number' },
  { dialect: 'generic', name: 'SIMILAR TO is boolean', expression: "b SIMILAR TO 'x%'", expectedFamily: 'boolean' },
  { dialect: 'generic', name: 'bitwise AND is numeric', expression: 'CAST(a AS BIGINT) & 1', expectedFamily: 'number' },
  {
    dialect: 'spark',
    name: 'ordered-set PERCENTILE_CONT is numeric',
    expression: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a)',
    expectedFamily: 'number',
  },
  {
    dialect: 'postgresql',
    name: 'ordered-set PERCENTILE_CONT is numeric',
    expression: 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a)',
    expectedFamily: 'number',
  },
];

const dialectSpecificComplexCases: ComplexTypeCase[] = [
  {
    dialect: 'spark',
    name: 'DISTINCT COLLECT_LIST retains its element type',
    expression: 'COLLECT_LIST(DISTINCT b)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'hive',
    name: 'DISTINCT COLLECT_LIST retains its element type',
    expression: 'COLLECT_LIST(DISTINCT b)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'flink',
    name: 'DISTINCT ARRAY_AGG retains its element type',
    expression: 'ARRAY_AGG(DISTINCT b)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'postgresql',
    name: 'DISTINCT ARRAY_AGG retains its element type',
    expression: 'ARRAY_AGG(DISTINCT b)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'trino',
    name: 'DISTINCT ARRAY_AGG retains its element type',
    expression: 'ARRAY_AGG(DISTINCT b)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'trino',
    name: 'ordered ARRAY_AGG retains its element type',
    expression: 'ARRAY_AGG(b ORDER BY a)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'impala',
    name: 'DISTINCT COLLECT_LIST retains its element type',
    expression: 'COLLECT_LIST(DISTINCT b)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'generic',
    name: 'DISTINCT ARRAY_AGG retains its element type',
    expression: 'ARRAY_AGG(DISTINCT b)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'spark',
    name: 'windowed COLLECT_LIST remains an array instead of becoming the Spark WINDOW struct',
    expression: 'COLLECT_LIST(b) OVER (PARTITION BY a)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'postgresql',
    name: 'windowed ARRAY_AGG remains an array',
    expression: 'ARRAY_AGG(b) OVER (PARTITION BY a)',
    expectedElementFamily: 'string',
  },
  {
    dialect: 'trino',
    name: 'windowed ARRAY_AGG remains an array',
    expression: 'ARRAY_AGG(b) OVER (PARTITION BY a)',
    expectedElementFamily: 'string',
  },
];

const temporalArithmeticCases: ScalarTypeCase[] = [
  {
    dialect: 'spark',
    name: 'DATE plus an integer remains a date',
    expression: "DATE '2020-01-01' + 1",
    expectedFamily: 'date',
  },
  {
    dialect: 'postgresql',
    name: 'DATE plus an integer remains a date',
    expression: "DATE '2020-01-01' + 1",
    expectedFamily: 'date',
  },
  {
    dialect: 'spark',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL 1 HOUR",
    expectedFamily: 'time',
  },
  {
    dialect: 'hive',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL '1' HOUR",
    expectedFamily: 'time',
  },
  {
    dialect: 'flink',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL '1' HOUR",
    expectedFamily: 'time',
  },
  {
    dialect: 'mysql',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL 1 HOUR",
    expectedFamily: 'time',
  },
  {
    dialect: 'postgresql',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL '1 hour'",
    expectedFamily: 'time',
  },
  {
    dialect: 'trino',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL '1' HOUR",
    expectedFamily: 'time',
  },
  {
    dialect: 'impala',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL 1 HOUR",
    expectedFamily: 'time',
  },
  {
    dialect: 'generic',
    name: 'TIMESTAMP plus an interval remains temporal',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL '1' HOUR",
    expectedFamily: 'time',
  },
];

// Deliberately red acceptance tests: every case below was observed to return
// UNKNOWN or an incorrect type before this test file was added.
describe('round four expression type inference failures', () => {
  it.each([
    ...windowTypeCases,
    ...commonWrapperTypeCases,
    ...portableOperatorTypeCases,
    ...dialectSpecificScalarCases,
    ...temporalArithmeticCases,
  ])('$dialect: $name', ({ dialect, expression, expectedFamily }) => {
    expectScalarFamily(projectionSymbol(expression, dialect), expectedFamily);
  });

  it.each(dialectSpecificComplexCases)('$dialect: $name', ({
    dialect,
    expression,
    expectedElementFamily,
  }) => {
    expectArrayElementFamily(projectionSymbol(expression, dialect), expectedElementFamily);
  });

  it('spark: a named window preserves the wrapped aggregate type', () => {
    const sql = 'SELECT MAX(a) OVER metric_window AS inferred_result FROM test '
      + 'WINDOW metric_window AS (PARTITION BY b)';
    expectValidSyntax(sql, 'spark');
    const symbol = getSqlSymbolAtOffset(sql, sql.indexOf('inferred_result'), 'spark', [], schemaFor('spark'));
    expectScalarFamily(symbol, 'number');
  });

  it('postgresql: timestamp subtraction infers an INTERVAL instead of a number', () => {
    const symbol = projectionSymbol(
      "TIMESTAMP '2020-01-02 00:00:00' - TIMESTAMP '2020-01-01 00:00:00'",
      'postgresql',
    );
    expect(symbol?.type?.toUpperCase()).toContain('INTERVAL');
  });

  it('spark: explicit TIMESTAMP DDL remains a temporal type', () => {
    const parsed = parseDdlSchema('CREATE TABLE timestamp_source (ts TIMESTAMP);', 'spark', 'timestamp.sql');
    expect(parsed.issues).toEqual([]);
    expect(parsed.tables[0]?.columns[0]?.dataType).toEqual(expect.objectContaining({
      kind: 'scalar',
      family: 'time',
    }));
  });
});

const globalCtasTypeCases: Array<Omit<ScalarTypeCase, 'dialect'>> = [
  {
    name: 'window output type propagates into a workspace CTAS',
    expression: 'MAX(a) OVER (PARTITION BY b)',
    expectedFamily: 'number',
  },
  { name: 'unary minus output type propagates into a workspace CTAS', expression: '-a', expectedFamily: 'number' },
  { name: 'LIKE output type propagates into a workspace CTAS', expression: "b LIKE '%x%'", expectedFamily: 'boolean' },
  { name: 'concatenation output type propagates into a workspace CTAS', expression: 'b || b', expectedFamily: 'string' },
  { name: 'DISTINCT aggregate output type propagates into a workspace CTAS', expression: 'MAX(DISTINCT a)', expectedFamily: 'number' },
  {
    name: 'scalar subquery output type propagates into a workspace CTAS',
    expression: '(SELECT MAX(nested.a) FROM test AS nested)',
    expectedFamily: 'number',
  },
  {
    name: 'temporal arithmetic output type propagates into a workspace CTAS',
    expression: "TIMESTAMP '2020-01-01 00:00:00' + INTERVAL 1 HOUR",
    expectedFamily: 'time',
  },
];

describe('round four inferred DDL type propagation failures', () => {
  it.each(globalCtasTypeCases)('spark: $name', ({ expression, expectedFamily }) => {
    const parsed = parseDdlSchema(
      `${ddlByDialect.spark}\nCREATE TABLE derived AS SELECT ${expression} AS inferred_result FROM test;`,
      'spark',
      'workspace-ctas.sql',
    );
    const snapshot = createSchemaSnapshot([parsed]);
    expect(snapshot.issues).toEqual([]);
    const column = snapshot.tables.find((table) => table.name === 'derived')?.columns[0];
    expect(column?.dataType).toEqual(expect.objectContaining({ kind: 'scalar', family: expectedFamily }));
  });

  it('spark: a local CTAS exposes its window result type to following statements', () => {
    const sql = `${ddlByDialect.spark}
CREATE TABLE derived AS SELECT MAX(a) OVER (PARTITION BY b) AS inferred_result FROM test;
SELECT inferred_result FROM derived;`;
    expectValidSyntax(sql, 'spark');
    const usage = getSqlSymbolAtOffset(sql, sql.lastIndexOf('inferred_result'), 'spark', [], { tables: [], issues: [] });
    expectScalarFamily(usage, 'number');
  });

  it.each([
    { name: 'window output type propagates into a workspace view', expression: 'MAX(a) OVER (PARTITION BY b)' },
    { name: 'scalar subquery output type propagates into a workspace view', expression: '(SELECT MAX(nested.a) FROM test nested)' },
  ])('spark: $name', ({ expression }) => {
    const parsed = parseDdlSchema(
      `${ddlByDialect.spark}\nCREATE VIEW derived_view AS SELECT ${expression} AS inferred_result FROM test;`,
      'spark',
      'workspace-view.sql',
    );
    const snapshot = createSchemaSnapshot([parsed]);
    expect(snapshot.issues).toEqual([]);
    const column = snapshot.tables.find((table) => table.name === 'derived_view')?.columns[0];
    expect(column?.dataType).toEqual(expect.objectContaining({ kind: 'scalar', family: 'number' }));
  });
});

function standardCreateQuerySql(prefix: string): string {
  return `${prefix} SELECT MAX(t.a) AS c FROM test AS t`;
}

const ctasNavigationCases: CreateQueryNavigationCase[] = SQL_DIALECTS.flatMap((dialect) => {
  const sql = standardCreateQuerySql('CREATE TABLE new_table AS');
  return [
    {
      dialect,
      name: 'CTAS source table has hover and a DDL definition',
      sql,
      offset: (text) => text.lastIndexOf('test'),
      expectedKind: 'table',
      expectedDefinitionSource: 'ddl',
    },
    {
      dialect,
      name: 'CTAS source qualifier has hover and a local definition',
      sql,
      offset: (text) => text.indexOf('t.a'),
      expectedKind: 'relation-alias',
      expectedDefinitionSource: 'local',
    },
    {
      dialect,
      name: 'CTAS source column has hover and a DDL definition',
      sql,
      offset: (text) => text.indexOf('a)'),
      expectedKind: 'column',
      expectedFamily: 'number',
      expectedDefinitionSource: 'ddl',
    },
    {
      dialect,
      name: 'CTAS function call has built-in hover',
      sql,
      offset: (text) => text.indexOf('MAX'),
      expectedKind: 'function',
      expectedFamily: 'number',
      expectedFunctionCategory: 'builtin',
    },
    {
      dialect,
      name: 'CTAS projection alias has inferred hover',
      sql,
      offset: (text) => text.indexOf('AS c') + 'AS '.length,
      expectedKind: 'projection',
      expectedFamily: 'number',
    },
  ];
});

const viewNavigationCases: CreateQueryNavigationCase[] = SQL_DIALECTS.flatMap((dialect) => {
  const sql = standardCreateQuerySql('CREATE VIEW new_view AS');
  return [
    {
      dialect,
      name: 'CREATE VIEW source table has hover and a DDL definition',
      sql,
      offset: (text) => text.lastIndexOf('test'),
      expectedKind: 'table',
      expectedDefinitionSource: 'ddl',
    },
    {
      dialect,
      name: 'CREATE VIEW source column has hover and a DDL definition',
      sql,
      offset: (text) => text.indexOf('a)'),
      expectedKind: 'column',
      expectedFamily: 'number',
      expectedDefinitionSource: 'ddl',
    },
  ];
});

const createQueryVariantCases: CreateQueryNavigationCase[] = [
  {
    dialect: 'spark',
    name: 'parenthesized CTAS query retains navigation',
    sql: 'CREATE TABLE new_table AS (SELECT a FROM test)',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
  {
    dialect: 'spark',
    name: 'CREATE OR REPLACE VIEW query retains navigation',
    sql: 'CREATE OR REPLACE VIEW new_view AS SELECT a FROM test',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
  {
    dialect: 'spark',
    name: 'CREATE TEMP VIEW query retains navigation',
    sql: 'CREATE TEMP VIEW new_view AS SELECT a FROM test',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
  {
    dialect: 'hive',
    name: 'CREATE MATERIALIZED VIEW query retains navigation',
    sql: 'CREATE MATERIALIZED VIEW new_view AS SELECT a FROM test',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
  {
    dialect: 'mysql',
    name: 'CREATE OR REPLACE VIEW query retains navigation',
    sql: 'CREATE OR REPLACE VIEW new_view AS SELECT a FROM test',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
  {
    dialect: 'postgresql',
    name: 'CREATE MATERIALIZED VIEW query retains navigation',
    sql: 'CREATE MATERIALIZED VIEW new_view AS SELECT a FROM test',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
  {
    dialect: 'postgresql',
    name: 'CREATE OR REPLACE VIEW query retains navigation',
    sql: 'CREATE OR REPLACE VIEW new_view AS SELECT a FROM test',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
  {
    dialect: 'trino',
    name: 'CREATE OR REPLACE VIEW query retains navigation',
    sql: 'CREATE OR REPLACE VIEW new_view AS SELECT a FROM test',
    offset: (sql) => sql.indexOf('a FROM'),
    expectedKind: 'column',
    expectedFamily: 'number',
    expectedDefinitionSource: 'ddl',
  },
];

function expectCreateQueryNavigation(testCase: CreateQueryNavigationCase): void {
  expectValidSyntax(testCase.sql, testCase.dialect);
  const symbol = getSqlSymbolAtOffset(
    testCase.sql,
    testCase.offset(testCase.sql),
    testCase.dialect,
    [],
    schemaFor(testCase.dialect),
  );
  expect(symbol).toBeDefined();
  expect(symbol?.kind).toBe(testCase.expectedKind);
  if (testCase.expectedFamily) expectScalarFamily(symbol, testCase.expectedFamily);
  if (testCase.expectedFunctionCategory) {
    expect(symbol?.functionCategory).toBe(testCase.expectedFunctionCategory);
  }
  if (testCase.expectedDefinitionSource === 'ddl') {
    expect(symbol?.definitions.some((definition) => (
      definition.location.source === `file:///${testCase.dialect}-source.sql`
    ))).toBe(true);
  }
  if (testCase.expectedDefinitionSource === 'local') {
    expect(symbol?.definitions.some((definition) => definition.location.source === '')).toBe(true);
  }
}

// Deliberately red acceptance tests for query bodies hidden by CREATE.
describe('round four CREATE query navigation failures', () => {
  it.each(ctasNavigationCases)('$dialect: $name', (testCase) => {
    expectCreateQueryNavigation(testCase);
  });

  it.each(viewNavigationCases)('$dialect: $name', (testCase) => {
    expectCreateQueryNavigation(testCase);
  });

  it.each(createQueryVariantCases)('$dialect: $name', (testCase) => {
    expectCreateQueryNavigation(testCase);
  });

  const nestedCtasSql = `CREATE TABLE new_table AS
WITH projected AS (SELECT a AS inner_a FROM test)
SELECT inner_a AS outer_a FROM projected`;
  it.each([
    { name: 'nested CTAS CTE declaration', needle: 'projected AS', occurrence: 0, expectedKind: 'cte' as const },
    { name: 'nested CTAS inner source column', needle: 'a AS inner', occurrence: 0, expectedKind: 'column' as const },
    { name: 'nested CTAS outer CTE column', needle: 'inner_a AS outer', occurrence: 0, expectedKind: 'column' as const },
    { name: 'nested CTAS CTE relation use', needle: 'projected', occurrence: 1, expectedKind: 'cte' as const },
  ])('spark: $name retains navigation', ({ needle, occurrence, expectedKind }) => {
    expectValidSyntax(nestedCtasSql, 'spark');
    let offset = -1;
    for (let index = 0; index <= occurrence; index += 1) offset = nestedCtasSql.indexOf(needle, offset + 1);
    const symbol = getSqlSymbolAtOffset(nestedCtasSql, offset, 'spark', [], schemaFor('spark'));
    expect(symbol).toBeDefined();
    expect(symbol?.kind).toBe(expectedKind);
  });
});

const mergeDialects: readonly SqlDialect[] = [
  'spark',
  'hive',
  'flink',
  'postgresql',
  'trino',
  'impala',
  'generic',
];

const validDeleteSql = 'DELETE FROM test WHERE a > 0';
const validMergeSql = 'MERGE INTO test AS target USING test AS source ON target.a = source.a '
  + 'WHEN MATCHED THEN UPDATE SET b = source.b '
  + 'WHEN NOT MATCHED THEN INSERT (a, b) VALUES (source.a, source.b)';

// DELETE and MERGE are classified as data statements, but their normalized AST
// roots currently never reach a semantic analyzer. These tests capture both the
// missing navigation and the missing diagnostics caused by that gap.
describe('round four DELETE and MERGE semantic-model failures', () => {
  it.each(SQL_DIALECTS)('%s: DELETE target table has hover and definition', (dialect) => {
    expectValidSyntax(validDeleteSql, dialect);
    const symbol = getSqlSymbolAtOffset(validDeleteSql, validDeleteSql.indexOf('test'), dialect, [], schemaFor(dialect));
    expect(symbol?.kind).toBe('table');
    expect(symbol?.definitions[0]?.location.source).toBe(`file:///${dialect}-source.sql`);
  });

  it.each(SQL_DIALECTS)('%s: DELETE predicate column has hover and definition', (dialect) => {
    expectValidSyntax(validDeleteSql, dialect);
    const symbol = getSqlSymbolAtOffset(validDeleteSql, validDeleteSql.indexOf('a >'), dialect, [], schemaFor(dialect));
    expect(symbol?.kind).toBe('column');
    expectScalarFamily(symbol, 'number');
    expect(symbol?.definitions[0]?.location.source).toBe(`file:///${dialect}-source.sql`);
  });

  it.each(SQL_DIALECTS)('%s: DELETE reports an unknown predicate column', (dialect) => {
    const sql = 'DELETE FROM test WHERE missing > 0';
    expectValidSyntax(sql, dialect);
    expect(analyzeSqlSemantics(sql, dialect, [], schemaFor(dialect), []).map((issue) => issue.code)).toContain(
      'unknown-column',
    );
  });

  it.each(SQL_DIALECTS)('%s: DELETE reports an unknown target table', (dialect) => {
    const sql = 'DELETE FROM missing_table WHERE a > 0';
    expectValidSyntax(sql, dialect);
    expect(analyzeSqlSemantics(sql, dialect, [], schemaFor(dialect), []).map((issue) => issue.code)).toContain(
      'unknown-table',
    );
  });

  it.each(mergeDialects)('%s: MERGE target table has hover and definition', (dialect) => {
    expectValidSyntax(validMergeSql, dialect);
    const symbol = getSqlSymbolAtOffset(validMergeSql, validMergeSql.indexOf('test'), dialect, [], schemaFor(dialect));
    expect(symbol?.kind).toBe('table');
    expect(symbol?.definitions[0]?.location.source).toBe(`file:///${dialect}-source.sql`);
  });

  it.each(mergeDialects)('%s: MERGE source table has hover and definition', (dialect) => {
    expectValidSyntax(validMergeSql, dialect);
    const symbol = getSqlSymbolAtOffset(validMergeSql, validMergeSql.lastIndexOf('test'), dialect, [], schemaFor(dialect));
    expect(symbol?.kind).toBe('table');
    expect(symbol?.definitions[0]?.location.source).toBe(`file:///${dialect}-source.sql`);
  });

  it.each(mergeDialects)('%s: MERGE match column has hover and definition', (dialect) => {
    expectValidSyntax(validMergeSql, dialect);
    const symbol = getSqlSymbolAtOffset(validMergeSql, validMergeSql.indexOf('target.a'), dialect, [], schemaFor(dialect));
    expect(symbol?.kind).toBe('relation-alias');
    expect(symbol?.definitions.length).toBeGreaterThan(0);
  });

  it.each(mergeDialects)('%s: MERGE reports an unknown match column', (dialect) => {
    const sql = validMergeSql.replace('target.a = source.a', 'target.missing = source.a');
    expectValidSyntax(sql, dialect);
    expect(analyzeSqlSemantics(sql, dialect, [], schemaFor(dialect), []).map((issue) => issue.code)).toContain(
      'unknown-column',
    );
  });

  it.each(mergeDialects)('%s: MERGE reports an unknown source table', (dialect) => {
    const sql = validMergeSql.replace('USING test AS source', 'USING missing_table AS source');
    expectValidSyntax(sql, dialect);
    expect(analyzeSqlSemantics(sql, dialect, [], schemaFor(dialect), []).map((issue) => issue.code)).toContain(
      'unknown-table',
    );
  });

  it('spark: MERGE checks UPDATE assignment types', () => {
    const sql = validMergeSql.replace('SET b = source.b', 'SET a = source.b');
    expectValidSyntax(sql, 'spark');
    expect(analyzeSqlSemantics(sql, 'spark', [], schemaFor('spark'), []).map((issue) => issue.code)).toContain(
      'incompatible-type',
    );
  });
});
