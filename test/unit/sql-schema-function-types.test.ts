import { describe, expect, it } from 'vitest';

import { analyzeSql, SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  getSqlSymbolAtOffset,
  parseDdlSchema,
  type SchemaSnapshot,
  type SqlSymbolResolution,
} from '../../src/sqlSchemaCore';
import {
  functionDiagnosticCases,
  functionTypeCases,
  type ExpectedFunctionType,
  type FunctionDiagnosticCase,
} from './sql-schema-function-types.cases';

// Discovery-only regression suite: deliberately ordinary failing tests, not
// it.fails/skip/todo and not assertions that bless today's incorrect result.
// See ../sql-schema-function-types.md for the investigation and reproduction.
const scalarColumns = 'n INT, s STRING, flag BOOLEAN, ts TIMESTAMP, d DATE, bin BINARY';
const collectionColumns = 'ints ARRAY<INT>, texts ARRAY<STRING>, bools ARRAY<BOOLEAN>, pairs MAP<STRING, INT>';
const ddlByDialect: Record<SqlDialect, string> = {
  spark: `CREATE TABLE typed_values (${scalarColumns}, ${collectionColumns});`,
  hive: `CREATE TABLE typed_values (${scalarColumns}, ${collectionColumns});`,
  flink: `CREATE TABLE typed_values (
    ${scalarColumns.replace('ts TIMESTAMP', 'ts TIMESTAMP(3)')}, ${collectionColumns}
  ) WITH ('connector'='values');`,
  mysql: `CREATE TABLE typed_values (
    n INT, s VARCHAR(100), flag BOOLEAN, ts DATETIME, d DATE, bin VARBINARY(100)
  );`,
  postgresql: `CREATE TABLE typed_values (
    n INT, s TEXT, flag BOOLEAN, ts TIMESTAMP, d DATE, bin BYTEA,
    ints INT[], texts TEXT[], bools BOOLEAN[]
  );`,
  trino: `CREATE TABLE typed_values (
    n INT, s VARCHAR, flag BOOLEAN, ts TIMESTAMP, d DATE, bin VARBINARY,
    ints ARRAY(INTEGER), texts ARRAY(VARCHAR), bools ARRAY(BOOLEAN), pairs MAP(VARCHAR, INTEGER)
  );`,
  impala: `CREATE TABLE typed_values (${scalarColumns});`,
  generic: `CREATE TABLE typed_values (
    n INT, s VARCHAR(100), flag BOOLEAN, ts TIMESTAMP, d DATE, bin VARBINARY(100)
  );`,
};

const schemas = new Map<SqlDialect, SchemaSnapshot>();

function schemaFor(dialect: SqlDialect): SchemaSnapshot {
  const cached = schemas.get(dialect);
  if (cached) return cached;
  const parsed = parseDdlSchema(ddlByDialect[dialect], dialect, `file:///${dialect}-function-types.sql`);
  expect(parsed.issues, `${dialect} DDL fixture`).toEqual([]);
  const schema = createSchemaSnapshot([parsed]);
  expect(schema.issues, `${dialect} schema snapshot`).toEqual([]);
  expect(schema.tables).toHaveLength(1);
  schemas.set(dialect, schema);
  return schema;
}

function expectValidSyntax(sql: string, dialect: SqlDialect): void {
  expect(analyzeSql(sql, dialect, []).issues, `${dialect}: ${sql}`).toEqual([]);
}

const scalar = (family: string) => ({ kind: 'scalar', family });
const array = (family: string) => ({ kind: 'array', elementType: scalar(family) });
const expectedShapes = {
  number: scalar('number'),
  string: scalar('string'),
  boolean: scalar('boolean'),
  date: scalar('date'),
  time: scalar('time'),
  binary: scalar('binary'),
  'array<number>': array('number'),
  'array<string>': array('string'),
  'array<boolean>': array('boolean'),
  'map<string,number>': { kind: 'map', keyType: scalar('string'), valueType: scalar('number') },
  'map<string,boolean>': { kind: 'map', keyType: scalar('string'), valueType: scalar('boolean') },
  'map<string,unknown>': { kind: 'map', keyType: scalar('string'), valueType: { kind: 'unknown' } },
  'map<string,array<boolean>>': { kind: 'map', keyType: scalar('string'), valueType: array('boolean') },
  'map<string,array<unknown>>': {
    kind: 'map', keyType: scalar('string'), valueType: { kind: 'array', elementType: { kind: 'unknown' } },
  },
  'struct<enabled:boolean>': {
    kind: 'struct', fields: [{ name: 'enabled', dataType: scalar('boolean') }],
  },
  'struct<value:unknown>': {
    kind: 'struct', fields: [{ name: 'value', dataType: { kind: 'unknown' } }],
  },
  INTERVAL: { kind: 'opaque', name: expect.stringMatching(/INTERVAL/iu) },
  REGTYPE: { kind: 'opaque', name: 'REGTYPE' },
};

function expectType(symbol: SqlSymbolResolution | undefined, expected: ExpectedFunctionType): void {
  expect(symbol, 'projection must expose its inferred type').toBeDefined();
  if (expected === 'JSON' || expected === 'JSONB') {
    // JSON is deliberately in the checker's string family: check the actual SQL
    // type name, not an invented requirement that every JSON type be opaque.
    expect(symbol?.type?.toUpperCase()).toBe(expected);
  } else {
    expect(symbol?.dataType).toMatchObject(expectedShapes[expected]);
  }
}

function projectionType(expression: string, dialect: SqlDialect): SqlSymbolResolution | undefined {
  const sql = `SELECT ${expression} AS inferred_result FROM typed_values`;
  expectValidSyntax(sql, dialect);
  return getSqlSymbolAtOffset(sql, sql.indexOf('inferred_result'), dialect, [], schemaFor(dialect));
}

function expectNoDiagnostics(testCase: FunctionDiagnosticCase): void {
  const sql = `SELECT ${testCase.expression} FROM typed_values`;
  expectValidSyntax(sql, testCase.dialect);
  const issues = analyzeSqlSemantics(sql, testCase.dialect, [], schemaFor(testCase.dialect), []);
  expect(issues.map((issue) => ({ code: issue.code, message: issue.message })), sql).toEqual([]);
}

describe('function return type discovery: fixture and passing controls', () => {
  it.each(SQL_DIALECTS)('%s: source columns are known and direct references are accepted', (dialect) => {
    const sql = 'SELECT n, s, ts, bin FROM typed_values';
    expectValidSyntax(ddlByDialect[dialect], dialect);
    expectValidSyntax(sql, dialect);
    expect(analyzeSqlSemantics(sql, dialect, [], schemaFor(dialect), [])).toEqual([]);
    expectType(projectionType('s', dialect), 'string');
    expectType(projectionType('bin', dialect), 'binary');
    if (['spark', 'hive', 'flink', 'postgresql', 'trino'].includes(dialect)) {
      expectType(projectionType('ints', dialect), 'array<number>');
      expectType(projectionType('texts', dialect), 'array<string>');
      expectType(projectionType('bools', dialect), 'array<boolean>');
    }
    if (['spark', 'hive', 'flink', 'trino'].includes(dialect)) {
      expectType(projectionType('pairs', dialect), 'map<string,number>');
    }
    expectType(projectionType('CASE WHEN flag THEN s ELSE NULL END', dialect), 'string');
    expectType(projectionType('lead(s, 1, s) OVER (ORDER BY n)', dialect), 'string');
  });

  it.each(['sort_array(ints)', 'sort_array(ints, flag)'])(
    'spark: %s preserves the array when no unpositioned boolean is present', (expression) => {
      expectType(projectionType(expression, 'spark'), 'array<number>');
      expectNoDiagnostics({ dialect: 'spark', expression: `transform(${expression}, x -> CAST(x AS STRING))` });
    },
  );

  it.each(['spark', 'flink', 'postgresql', 'trino'] as const)(
    '%s: one-argument ARRAY_SORT remains valid', (dialect) => {
      expectType(projectionType('array_sort(ints)', dialect), 'array<number>');
      expectNoDiagnostics({ dialect, expression: 'array_sort(ints)' });
    },
  );

  it.each(['spark', 'flink', 'trino'] as const)(
    '%s: an explicit regexp group preserves the string element type', (dialect) => {
      expectType(projectionType("regexp_extract_all(s, '(.)', 1)", dialect), 'array<string>');
    },
  );

  it('still rejects genuinely invalid TRANSFORM and SHA2 arguments', () => {
    for (const expression of ['transform(flag, x -> x)', "sha2(s, 'not-a-number')"]) {
      const sql = `SELECT ${expression} FROM typed_values`;
      expectValidSyntax(sql, 'spark');
      expect(analyzeSqlSemantics(sql, 'spark', [], schemaFor('spark'), []).map((issue) => issue.code))
        .toContain('function-argument-type');
    }
  });
});

describe('function return type discovery: wrong or lost result types', () => {
  it.each(functionTypeCases)('$dialect: $expression -> $expected', (testCase) => {
    // This assertion is independent of diagnostic suppression for UNKNOWN.
    expectType(projectionType(testCase.expression, testCase.dialect), testCase.expected);
  });
});

const nestedCases: readonly FunctionDiagnosticCase[] = functionTypeCases.flatMap((testCase) => (
  testCase.consumer ? [{
    dialect: testCase.dialect,
    expression: testCase.consumer.replaceAll('{value}', testCase.expression),
  }] : []
));

describe('function return type discovery: valid nested calls must not be rejected', () => {
  it.each(nestedCases)('$dialect: $expression', expectNoDiagnostics);
});

describe('function return type discovery: legal overloads, constructors and NULL arguments', () => {
  it.each(functionDiagnosticCases)('$dialect: $expression', expectNoDiagnostics);
});

const sparkPropagationCases = [
  {
    name: 'original user report, with local CREATE TABLE',
    sql: `create table test_table (int_data array<int>);
select transform(sort_array(int_data, false), x -> cast(x as string)) from test_table;`,
  },
  {
    name: 'a sorted array flowing through a CTE',
    sql: `WITH sorted AS (SELECT sort_array(ints, false) AS items FROM typed_values)
SELECT transform(items, x -> CAST(x AS STRING)) FROM sorted`,
  },
  {
    name: 'a sorted array flowing through a derived table',
    sql: `SELECT transform(items, x -> CAST(x AS STRING))
FROM (SELECT sort_array(ints, false) AS items FROM typed_values) sorted`,
  },
  {
    name: 'a sorted array flowing through a local view',
    sql: `CREATE TEMPORARY VIEW sorted AS SELECT sort_array(ints, false) AS items FROM typed_values;
SELECT transform(items, x -> CAST(x AS STRING)) FROM sorted`,
  },
  {
    name: 'a sorted array flowing through CTAS',
    sql: `CREATE TABLE sorted AS SELECT sort_array(ints, false) AS items FROM typed_values;
SELECT transform(items, x -> CAST(x AS STRING)) FROM sorted`,
  },
  {
    name: 'a sorted array assigned to an ARRAY column',
    sql: `CREATE TABLE destination (items ARRAY<INT>);
INSERT INTO destination SELECT sort_array(ints, false) FROM typed_values`,
  },
  {
    name: 'a sorted array used in an ARRAY UNION branch',
    sql: `SELECT sort_array(ints, false) AS items FROM typed_values
UNION ALL SELECT ints FROM typed_values`,
  },
  ...[
    ['EXISTS', 'exists(sort_array(ints, false), x -> x > 0)'],
    ['FORALL', 'forall(sort_array(ints, false), x -> x > 0)'],
    ['ZIP_WITH', 'zip_with(sort_array(ints, false), ints, (x, y) -> x + y)'],
    ['ARRAY_SORT', 'array_sort(sort_array(ints, false))'],
  ].map(([name, expression]) => ({ name: `a poisoned result consumed by ${name}`, sql: `SELECT ${expression} FROM typed_values` })),
];

describe('function return type discovery: Spark statement and scope propagation', () => {
  it.each(sparkPropagationCases)('$name', ({ sql }) => {
    expectValidSyntax(sql, 'spark');
    expect(analyzeSqlSemantics(sql, 'spark', [], schemaFor('spark'), []).map((issue) => ({
      code: issue.code, message: issue.message,
    })), sql).toEqual([]);
  });
});
