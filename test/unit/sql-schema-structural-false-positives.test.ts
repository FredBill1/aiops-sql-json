import { describe, expect, it } from 'vitest';

import { analyzeSql, SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  parseDdlSchema,
  type SchemaSnapshot,
} from '../../src/sqlSchemaCore';

interface ValidSchemaCase {
  dialect: SqlDialect;
  name: string;
  sql: string;
}

const ddlByDialect: Record<SqlDialect, string> = {
  spark: 'CREATE TABLE test_table (a INT, b STRING, c STRING);',
  hive: 'CREATE TABLE test_table (a INT, b STRING, c STRING);',
  flink: "CREATE TABLE test_table (a INT, b STRING, c STRING) WITH ('connector'='values');",
  mysql: 'CREATE TABLE test_table (a INT, b VARCHAR(100), c VARCHAR(100));',
  postgresql: 'CREATE TABLE test_table (a INTEGER, b TEXT, c TEXT);',
  trino: 'CREATE TABLE test_table (a INTEGER, b VARCHAR, c VARCHAR);',
  impala: 'CREATE TABLE test_table (a INT, b STRING, c STRING);',
  generic: 'CREATE TABLE test_table (a INTEGER, b VARCHAR(100), c VARCHAR(100));',
};

const snapshots = new Map<SqlDialect, SchemaSnapshot>();

function schemaFor(dialect: SqlDialect): SchemaSnapshot {
  const cached = snapshots.get(dialect);
  if (cached) return cached;
  const parsed = parseDdlSchema(ddlByDialect[dialect], dialect, `file:///${dialect}-structural-schema.sql`);
  expect(parsed.issues, `${dialect} structural false-positive DDL fixture`).toEqual([]);
  const snapshot = createSchemaSnapshot([parsed]);
  expect(snapshot.issues, `${dialect} structural false-positive schema snapshot`).toEqual([]);
  snapshots.set(dialect, snapshot);
  return snapshot;
}

function windowCase(dialect: SqlDialect, name: string, selectList: string): ValidSchemaCase {
  return {
    dialect,
    name,
    sql: `SELECT ${selectList} FROM test_table`,
  };
}

const repeatedInlineWindowCases: readonly ValidSchemaCase[] = SQL_DIALECTS.flatMap((dialect) => [
  windowCase(
    dialect,
    'two ROW_NUMBER windows have independent ORDER BY clauses',
    `ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn1,
ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn2`,
  ),
  windowCase(
    dialect,
    'different window functions have independent ORDER BY clauses',
    `ROW_NUMBER() OVER (ORDER BY b) AS rn,
RANK() OVER (ORDER BY b) AS ranking`,
  ),
  windowCase(
    dialect,
    'window ORDER BY clauses remain independent inside separate CASE branches',
    `CASE WHEN a > 0 THEN ROW_NUMBER() OVER (ORDER BY b)
     ELSE RANK() OVER (ORDER BY b) END AS conditional_rank`,
  ),
  {
    dialect,
    name: 'window functions in the select list and query ORDER BY have independent specifications',
    sql: `SELECT ROW_NUMBER() OVER (ORDER BY b) AS rn
FROM test_table
ORDER BY RANK() OVER (ORDER BY b)`,
  },
  windowCase(
    dialect,
    'nested scalar wrappers do not merge their window ORDER BY clauses',
    `COALESCE(ROW_NUMBER() OVER (ORDER BY b), 0) AS first_rank,
COALESCE(RANK() OVER (ORDER BY b), 0) AS second_rank`,
  ),
  windowCase(
    dialect,
    'window frames belong to separate ordered window specifications',
    `SUM(a) OVER (ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_sum,
AVG(a) OVER (ORDER BY b ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS moving_average`,
  ),
]);

const originalSparkReproduction: ValidSchemaCase = {
  dialect: 'spark',
  name: 'local DDL followed by two ordered ROW_NUMBER windows',
  sql: `CREATE TABLE local_test_table (a STRING, b STRING);
SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn1,
       ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn2
FROM local_test_table;`,
};

const namedWindowCases: readonly ValidSchemaCase[] = [
  ...(['spark', 'hive', 'flink', 'mysql', 'postgresql', 'trino', 'generic'] as const).map((dialect) => ({
    dialect,
    name: 'two named window definitions have independent ORDER BY clauses',
    sql: `SELECT SUM(a) OVER w1 AS sum_a, MAX(a) OVER w2 AS max_a
FROM test_table
WINDOW w1 AS (PARTITION BY c ORDER BY b),
       w2 AS (PARTITION BY c ORDER BY b)`,
  })),
  {
    dialect: 'mysql',
    name: 'two inline extensions of one named window have independent ORDER BY clauses',
    sql: `SELECT FIRST_VALUE(b) OVER (w ORDER BY a ASC) AS first_b,
       FIRST_VALUE(b) OVER (w ORDER BY a DESC) AS last_b
FROM test_table
WINDOW w AS (PARTITION BY c)`,
  },
];

const orderedAggregateCases: readonly ValidSchemaCase[] = [
  windowCase(
    'spark',
    'two ordered-set aggregates have independent WITHIN GROUP orderings',
    `PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a) AS p25,
PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a) AS p75`,
  ),
  windowCase(
    'spark',
    'two LISTAGG calls have independent WITHIN GROUP orderings',
    `LISTAGG(b, ',') WITHIN GROUP (ORDER BY a) AS ascending_values,
LISTAGG(b, ',') WITHIN GROUP (ORDER BY a DESC) AS descending_values`,
  ),
  windowCase(
    'postgresql',
    'two ARRAY_AGG calls have independent aggregate ORDER BY clauses',
    `ARRAY_AGG(b ORDER BY a) AS ascending_values,
ARRAY_AGG(b ORDER BY a DESC) AS descending_values`,
  ),
  windowCase(
    'postgresql',
    'two STRING_AGG calls have independent aggregate ORDER BY clauses',
    `STRING_AGG(b, ',' ORDER BY a) AS ascending_values,
STRING_AGG(b, ',' ORDER BY a DESC) AS descending_values`,
  ),
  windowCase(
    'postgresql',
    'two ordered-set aggregates have independent WITHIN GROUP orderings',
    `PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a) AS p25,
PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a) AS p75`,
  ),
  windowCase(
    'postgresql',
    'two MODE ordered-set aggregates have independent WITHIN GROUP orderings',
    `MODE() WITHIN GROUP (ORDER BY b) AS mode_b,
MODE() WITHIN GROUP (ORDER BY c) AS mode_c`,
  ),
  windowCase(
    'trino',
    'two ARRAY_AGG calls have independent aggregate ORDER BY clauses',
    `ARRAY_AGG(b ORDER BY a) AS ascending_values,
ARRAY_AGG(b ORDER BY a DESC) AS descending_values`,
  ),
  windowCase(
    'mysql',
    'two GROUP_CONCAT calls have independent aggregate ORDER BY clauses',
    `GROUP_CONCAT(b ORDER BY a) AS ascending_values,
GROUP_CONCAT(b ORDER BY a DESC) AS descending_values`,
  ),
  windowCase(
    'trino',
    'two LISTAGG calls have independent WITHIN GROUP orderings',
    `LISTAGG(b, ',' ON OVERFLOW ERROR) WITHIN GROUP (ORDER BY a) AS ascending_values,
LISTAGG(b, ',' ON OVERFLOW ERROR) WITHIN GROUP (ORDER BY a DESC) AS descending_values`,
  ),
  windowCase(
    'generic',
    'two standard LISTAGG calls have independent WITHIN GROUP orderings',
    `LISTAGG(b, ',') WITHIN GROUP (ORDER BY a) AS ascending_values,
LISTAGG(b, ',') WITHIN GROUP (ORDER BY a DESC) AS descending_values`,
  ),
  windowCase(
    'postgresql',
    'an ordered aggregate and an ordered window keep separate ORDER BY scopes',
    `ARRAY_AGG(b ORDER BY a) AS ordered_values,
ROW_NUMBER() OVER (ORDER BY b) AS rn`,
  ),
  windowCase(
    'postgresql',
    'two JSON_ARRAYAGG calls keep independent ordering and null handling',
    `JSON_ARRAYAGG(b ORDER BY a NULL ON NULL) AS values_with_nulls,
JSON_ARRAYAGG(c ORDER BY a ABSENT ON NULL) AS values_without_nulls`,
  ),
];

const patternRecognitionCases: readonly ValidSchemaCase[] = [
  {
    dialect: 'trino',
    name: 'two MATCH_RECOGNIZE inputs have independent ORDER BY clauses',
    sql: `SELECT left_match.c, left_match.matched_a, right_match.matched_a
FROM test_table MATCH_RECOGNIZE (
  PARTITION BY c
  ORDER BY a
  MEASURES FIRST(A.a) AS matched_a
  PATTERN (A)
  DEFINE A AS TRUE
) AS left_match
JOIN test_table MATCH_RECOGNIZE (
  PARTITION BY c
  ORDER BY a
  MEASURES FIRST(A.a) AS matched_a
  PATTERN (A)
  DEFINE A AS TRUE
) AS right_match ON TRUE`,
  },
];

const repeatedOnKeywordCases: readonly ValidSchemaCase[] = [
  ...(['flink', 'postgresql', 'trino'] as const).map((dialect) => ({
    dialect,
    name: 'two JSON_ARRAY constructors have independent ON NULL clauses',
    sql: `SELECT JSON_ARRAY(NULL NULL ON NULL) AS values_with_nulls,
       JSON_ARRAY(NULL ABSENT ON NULL) AS values_without_nulls`,
  })),
  {
    dialect: 'flink',
    name: 'two JSON_OBJECT constructors have independent ON NULL clauses',
    sql: `SELECT JSON_OBJECT(KEY 'value' VALUE NULL NULL ON NULL) AS object_with_null,
       JSON_OBJECT(KEY 'value' VALUE NULL ABSENT ON NULL) AS object_without_null`,
  },
  {
    dialect: 'postgresql',
    name: 'two JSON_OBJECT constructors have independent ON NULL clauses',
    sql: `SELECT JSON_OBJECT(KEY 'value' VALUE NULL NULL ON NULL) AS object_with_null,
       JSON_OBJECT(KEY 'value' VALUE NULL ABSENT ON NULL) AS object_without_null`,
  },
  {
    dialect: 'trino',
    name: 'two JSON_OBJECT constructors have independent ON NULL clauses',
    sql: `SELECT JSON_OBJECT('value' : NULL NULL ON NULL) AS object_with_null,
       JSON_OBJECT('value' : NULL ABSENT ON NULL) AS object_without_null`,
  },
  {
    dialect: 'mysql',
    name: 'JSON_VALUE permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT JSON_VALUE(
  '{"value": 1}', '$.value'
  RETURNING SIGNED
  DEFAULT 0 ON EMPTY
  DEFAULT 0 ON ERROR
) AS value`,
  },
  {
    dialect: 'flink',
    name: 'JSON_VALUE permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT JSON_VALUE(
  '{"value": 1}', '$.value'
  RETURNING INTEGER
  DEFAULT 0 ON EMPTY
  DEFAULT 0 ON ERROR
) AS value`,
  },
  {
    dialect: 'postgresql',
    name: 'JSON_VALUE permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT JSON_VALUE(
  JSONB '{"value": 1}', '$.value'
  RETURNING INTEGER
  DEFAULT 0 ON EMPTY
  DEFAULT 0 ON ERROR
) AS value`,
  },
  {
    dialect: 'trino',
    name: 'JSON_VALUE permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT JSON_VALUE(
  '{"value": 1}', 'lax $.value'
  RETURNING INTEGER
  DEFAULT 0 ON EMPTY
  DEFAULT 0 ON ERROR
) AS value`,
  },
  {
    dialect: 'flink',
    name: 'JSON_QUERY permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT JSON_QUERY(
  '{"value": [1]}', 'lax $.missing'
  EMPTY ARRAY ON EMPTY
  EMPTY ARRAY ON ERROR
) AS value`,
  },
  {
    dialect: 'postgresql',
    name: 'JSON_QUERY permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT JSON_QUERY(
  JSONB '{"value": [1]}', 'lax $.missing'
  EMPTY ARRAY ON EMPTY
  EMPTY ARRAY ON ERROR
) AS value`,
  },
  {
    dialect: 'trino',
    name: 'JSON_QUERY permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT JSON_QUERY(
  '{"value": [1]}', 'lax $.missing'
  EMPTY ARRAY ON EMPTY
  EMPTY ARRAY ON ERROR
) AS value`,
  },
  {
    dialect: 'mysql',
    name: 'JSON_TABLE permits both ON EMPTY and ON ERROR handlers',
    sql: `SELECT jt.value
FROM test_table
JOIN JSON_TABLE(
  '[1]',
  '$[*]' COLUMNS(value INT PATH '$' DEFAULT '0' ON EMPTY DEFAULT '0' ON ERROR)
) AS jt ON TRUE`,
  },
  {
    dialect: 'postgresql',
    name: 'INSERT SELECT permits a JOIN condition before ON CONFLICT',
    sql: `INSERT INTO test_table (a, b, c)
SELECT source.a, source.b, source.c
FROM test_table AS source
JOIN test_table AS other ON source.a = other.a
ON CONFLICT (a) DO NOTHING`,
  },
  {
    dialect: 'mysql',
    name: 'INSERT SELECT permits a JOIN condition before ON DUPLICATE KEY UPDATE',
    sql: `INSERT INTO test_table (a, b, c)
SELECT source.a, source.b, source.c
FROM test_table AS source
JOIN test_table AS other ON source.a = other.a
ON DUPLICATE KEY UPDATE b = VALUES(b)`,
  },
  {
    dialect: 'postgresql',
    name: 'INSERT SELECT permits DISTINCT ON before ON CONFLICT',
    sql: `INSERT INTO test_table (a, b, c)
SELECT DISTINCT ON (a) a, b, c
FROM test_table
ORDER BY a, b
ON CONFLICT (a) DO NOTHING`,
  },
];

const allCases = [
  originalSparkReproduction,
  ...repeatedInlineWindowCases,
  ...namedWindowCases,
  ...orderedAggregateCases,
  ...patternRecognitionCases,
  ...repeatedOnKeywordCases,
];

// These are deliberately red acceptance tests. Every statement is valid in its selected dialect
// and should produce no diagnostic with schema validation enabled. Each case currently exposes a
// structural validator false positive caused by state leaking between independent SQL constructs.
// A few fallback-parser cases also surface otherwise-suppressed parser errors once that structural
// false positive exists; those diagnostics are part of the same schema-enabled user-visible failure.
describe('schema-enabled structural false positives', () => {
  it.each(allCases)('$dialect: $name', ({ dialect, sql }) => {
    const syntaxIssues = analyzeSql(sql, dialect, []).issues.map((issue) => issue.message);
    const semanticIssues = analyzeSqlSemantics(sql, dialect, [], schemaFor(dialect), [])
      .map((issue) => `${issue.code}: ${issue.message}`);

    expect({ syntaxIssues, semanticIssues }, sql).toEqual({
      syntaxIssues: [],
      semanticIssues: [],
    });
  });
});
