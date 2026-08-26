import { describe, expect, it } from 'vitest';

import { compilePlaceholderPatterns } from '../../src/patterns';
import { analyzeSql, SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import {
  createSchemaSnapshot,
  getSqlSymbolAtOffset,
  parseDdlSchema,
  type SchemaSnapshot,
  type SqlSymbolKind,
} from '../../src/sqlSchemaCore';

interface NavigationCase {
  dialect: SqlDialect;
  name: string;
  sql: string;
  target: string;
  targetWithin?: string;
  expectedKind?: SqlSymbolKind;
  expectedName: string;
  placeholderPatterns?: readonly RegExp[];
}

const ddlByDialect: Record<SqlDialect, string> = {
  spark: `CREATE TABLE source_table (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE source_two (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE destination (control_text STRING, target_text STRING, target_num DOUBLE);`,
  hive: `CREATE TABLE source_table (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE source_two (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE destination (control_text STRING, target_text STRING, target_num DOUBLE);`,
  flink: `CREATE TABLE source_table (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP(3)
  ) WITH ('connector'='values');
  CREATE TABLE source_two (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP(3)
  ) WITH ('connector'='values');
  CREATE TABLE destination (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE
  ) WITH ('connector'='values');`,
  mysql: `CREATE TABLE source_table (
    control_text VARCHAR(100),
    target_text VARCHAR(100),
    target_num DOUBLE,
    target_ts DATETIME
  );
  CREATE TABLE source_two (
    control_text VARCHAR(100),
    target_text VARCHAR(100),
    target_num DOUBLE,
    target_ts DATETIME
  );
  CREATE TABLE destination (control_text VARCHAR(100), target_text VARCHAR(100), target_num DOUBLE);`,
  postgresql: `CREATE TABLE source_table (
    control_text TEXT,
    target_text TEXT,
    target_num DOUBLE PRECISION,
    target_ts TIMESTAMP
  );
  CREATE TABLE source_two (
    control_text TEXT,
    target_text TEXT,
    target_num DOUBLE PRECISION,
    target_ts TIMESTAMP
  );
  CREATE TABLE destination (control_text TEXT, target_text TEXT, target_num DOUBLE PRECISION);`,
  trino: `CREATE TABLE source_table (
    control_text VARCHAR,
    target_text VARCHAR,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE source_two (
    control_text VARCHAR,
    target_text VARCHAR,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE destination (control_text VARCHAR, target_text VARCHAR, target_num DOUBLE);`,
  impala: `CREATE TABLE source_table (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE source_two (
    control_text STRING,
    target_text STRING,
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE destination (control_text STRING, target_text STRING, target_num DOUBLE);`,
  generic: `CREATE TABLE source_table (
    control_text VARCHAR(100),
    target_text VARCHAR(100),
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE source_two (
    control_text VARCHAR(100),
    target_text VARCHAR(100),
    target_num DOUBLE,
    target_ts TIMESTAMP
  );
  CREATE TABLE destination (control_text VARCHAR(100), target_text VARCHAR(100), target_num DOUBLE);`,
};

const snapshots = new Map<SqlDialect, SchemaSnapshot>();
const defaultPlaceholderPatterns = compilePlaceholderPatterns([
  '\\$\\{[^}]+\\}',
  '\\$\\w+',
]).patterns;

function schemaFor(dialect: SqlDialect): SchemaSnapshot {
  const cached = snapshots.get(dialect);
  if (cached) return cached;
  const parsed = parseDdlSchema(ddlByDialect[dialect], dialect, `file:///${dialect}-round5-schema.sql`);
  expect(parsed.issues, `${dialect} round-five DDL fixture`).toEqual([]);
  const snapshot = createSchemaSnapshot([parsed]);
  expect(snapshot.issues, `${dialect} round-five schema snapshot`).toEqual([]);
  snapshots.set(dialect, snapshot);
  return snapshot;
}

function expectNavigation(testCase: NavigationCase): void {
  const syntaxIssues = analyzeSql(
    testCase.sql,
    testCase.dialect,
    testCase.placeholderPatterns ?? [],
  ).issues.map((issue) => issue.message);
  expect.soft(syntaxIssues, testCase.sql).toEqual([]);

  const targetStart = testCase.sql.lastIndexOf(testCase.target);
  expect(targetStart, testCase.target).toBeGreaterThanOrEqual(0);
  const targetWithin = testCase.targetWithin ?? testCase.target;
  const relativeOffset = testCase.target.indexOf(targetWithin);
  expect(relativeOffset, `${testCase.target} -> ${targetWithin}`).toBeGreaterThanOrEqual(0);
  const symbol = getSqlSymbolAtOffset(
    testCase.sql,
    targetStart + relativeOffset,
    testCase.dialect,
    testCase.placeholderPatterns ?? [],
    schemaFor(testCase.dialect),
  );

  expect(symbol, `${testCase.dialect}: ${testCase.name}`).toBeDefined();
  expect(symbol?.kind).toBe(testCase.expectedKind ?? 'column');
  expect(symbol?.name.toLocaleLowerCase()).toBe(testCase.expectedName.toLocaleLowerCase());
  expect(symbol?.definitions.some((definition) => (
    definition.location.source === `file:///${testCase.dialect}-round5-schema.sql`
      && definition.name.toLocaleLowerCase() === testCase.expectedName.toLocaleLowerCase()
  ))).toBe(true);
}

function columnCase(
  dialect: SqlDialect,
  name: string,
  sql: string,
  target: string,
  expectedName: string,
  targetWithin = expectedName,
): NavigationCase {
  return { dialect, name, sql, target, targetWithin, expectedName };
}

function placeholderColumnCase(
  dialect: SqlDialect,
  name: string,
  sql: string,
  target: string,
  expectedName: string,
  targetWithin = expectedName,
): NavigationCase {
  return {
    ...columnCase(dialect, name, sql, target, expectedName, targetWithin),
    placeholderPatterns: defaultPlaceholderPatterns,
  };
}

const setOperationCases: NavigationCase[] = SQL_DIALECTS.flatMap((dialect) => [
  columnCase(
    dialect,
    'a UNION result column in the final ORDER BY has Hover and definitions',
    `SELECT control_text, target_text FROM source_table
UNION ALL
SELECT control_text, target_text FROM source_two
ORDER BY target_text`,
    'ORDER BY target_text',
    'target_text',
  ),
  columnCase(
    dialect,
    'a CTE attached to a set-operation root retains source-column navigation',
    `WITH c AS (
  SELECT control_text, target_text AS cte_value FROM source_table
)
SELECT control_text, cte_value FROM c
UNION ALL
SELECT control_text, target_text FROM source_two`,
    'target_text AS cte_value',
    'target_text',
  ),
]);

const namedWindowDialects: readonly SqlDialect[] = [
  'spark',
  'hive',
  'flink',
  'mysql',
  'postgresql',
  'trino',
  'generic',
];

const namedWindowSql = `SELECT control_text, SUM(target_num) OVER named_window
FROM source_table
WINDOW named_window AS (PARTITION BY target_text ORDER BY target_num)`;

const selectClauseCases: NavigationCase[] = [
  ...namedWindowDialects.flatMap((dialect) => [
    columnCase(
      dialect,
      'a named WINDOW PARTITION BY column has Hover and a definition',
      namedWindowSql,
      'PARTITION BY target_text',
      'target_text',
    ),
    columnCase(
      dialect,
      'a named WINDOW ORDER BY column has Hover and a definition',
      namedWindowSql,
      'ORDER BY target_num',
      'target_num',
    ),
  ]),
  ...(['spark', 'hive'] as const).flatMap((dialect) => [
    columnCase(
      dialect,
      'a DISTRIBUTE BY column has Hover and a definition',
      'SELECT control_text FROM source_table DISTRIBUTE BY target_text',
      'DISTRIBUTE BY target_text',
      'target_text',
    ),
    columnCase(
      dialect,
      'a bucket TABLESAMPLE column has Hover and a definition',
      'SELECT control_text FROM source_table TABLESAMPLE(BUCKET 1 OUT OF 10 ON target_num)',
      'ON target_num',
      'target_num',
    ),
  ]),
  ...(['spark', 'trino'] as const).flatMap((dialect) => [
    columnCase(
      dialect,
      'a PIVOT aggregate argument has Hover and a definition',
      "SELECT control_text FROM source_table PIVOT (SUM(target_num) FOR target_text IN ('x'))",
      'SUM(target_num)',
      'target_num',
    ),
    columnCase(
      dialect,
      'a PIVOT key column has Hover and a definition',
      "SELECT control_text FROM source_table PIVOT (SUM(target_num) FOR target_text IN ('x'))",
      'FOR target_text',
      'target_text',
    ),
  ]),
  columnCase(
    'spark',
    'an UNPIVOT input column has Hover and a definition',
    `SELECT control_text, metric_name, metric_value
FROM source_table
UNPIVOT (metric_value FOR metric_name IN (target_num))`,
    'IN (target_num)',
    'target_num',
  ),
  columnCase(
    'flink',
    'a temporal-join AS OF column has Hover and a definition',
    `SELECT o.control_text
FROM source_table AS o
LEFT JOIN source_two FOR SYSTEM_TIME AS OF o.target_ts AS s
  ON o.control_text = s.control_text`,
    'o.target_ts',
    'target_ts',
  ),
  columnCase(
    'flink',
    'a window TVF DESCRIPTOR column has Hover and a definition',
    `SELECT window_start, COUNT(*)
FROM TABLE(
  TUMBLE(TABLE source_table, DESCRIPTOR(target_ts), INTERVAL '1' HOUR)
)
GROUP BY window_start, window_end`,
    'DESCRIPTOR(target_ts)',
    'target_ts',
  ),
  columnCase(
    'trino',
    'a MATCH_RECOGNIZE partition column has Hover and a definition',
    `SELECT *
FROM source_table MATCH_RECOGNIZE (
  PARTITION BY target_text
  ORDER BY target_num
  MEASURES A.target_num AS measured
  PATTERN (A)
  DEFINE A AS A.target_num > 0
)`,
    'PARTITION BY target_text',
    'target_text',
  ),
  columnCase(
    'flink',
    'a MATCH_RECOGNIZE partition column has Hover and a definition',
    `SELECT *
FROM source_table MATCH_RECOGNIZE (
  PARTITION BY target_text
  ORDER BY target_num
  MEASURES A.target_num AS measured
  PATTERN (A)
  DEFINE A AS A.target_num > 0
)`,
    'PARTITION BY target_text',
    'target_text',
  ),
];

const updateFromSql = `UPDATE source_table AS t
SET target_num = s.target_num
FROM source_two AS s
WHERE t.control_text = s.control_text
RETURNING t.target_text`;

const mysqlUpdateJoinSql = `UPDATE source_table AS t
JOIN source_two AS s ON t.control_text = s.control_text
SET t.target_num = s.target_num
WHERE s.target_text <> ''`;

const placeholderInsertCases: NavigationCase[] = [
  ...SQL_DIALECTS.flatMap((dialect) => [
    placeholderColumnCase(
      dialect,
      'a CAST operand in an INSERT SELECT with a placeholder-qualified target has Hover and a definition',
      `INSERT INTO \${namespace}.destination (target_num)
SELECT CAST(s.target_num AS DOUBLE)
FROM source_table AS s`,
      'CAST(s.target_num AS DOUBLE)',
      'target_num',
      'target_num',
    ),
    placeholderColumnCase(
      dialect,
      'a nested COALESCE/CAST operand in an INSERT SELECT with a placeholder-qualified target has Hover and a definition',
      `INSERT INTO \${namespace}.destination (target_num)
SELECT COALESCE(CAST(s.target_num AS DOUBLE), 0)
FROM source_table AS s`,
      'COALESCE(CAST(s.target_num AS DOUBLE), 0)',
      'target_num',
      'target_num',
    ),
  ]),
  ...(['spark', 'hive', 'impala'] as const).map((dialect) => placeholderColumnCase(
    dialect,
    'a nested SPLIT/subscript/CAST operand after a placeholder-valued static partition has Hover and a definition',
    `INSERT OVERWRITE TABLE destination PARTITION (partition_key = '$date$hour')
SELECT COALESCE(CAST(SPLIT(target_text, ',')[0] AS DOUBLE), -1.0), target_text, control_text
FROM source_table`,
    "SPLIT(target_text, ',')[0]",
    'target_text',
  )),
  placeholderColumnCase(
    'flink',
    'a nested SPLIT/subscript/CAST operand after a placeholder-valued static partition has Hover and a definition',
    `INSERT OVERWRITE destination PARTITION (partition_key = '$date$hour')
SELECT COALESCE(CAST(SPLIT(target_text, ',')[1] AS DOUBLE), -1.0), target_text, control_text
FROM source_table`,
    "SPLIT(target_text, ',')[1]",
    'target_text',
  ),
];

const placeholderBeforeCastCases: NavigationCase[] = SQL_DIALECTS.flatMap((dialect) => [
  placeholderColumnCase(
    dialect,
    'a CAST operand after an earlier placeholder projection has Hover and a definition',
    `SELECT '$run_date' AS batch_marker,
  CAST(target_num AS DOUBLE) AS parsed_value,
  target_num
FROM source_table`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    dialect,
    'a CAST operand in a later CTE has Hover and a definition when an earlier CTE contains a placeholder',
    `WITH filtered AS (
  SELECT control_text FROM source_two WHERE control_text = '$run_date'
), calculated AS (
  SELECT CAST(target_num AS DOUBLE) AS parsed_value, target_num FROM source_table
)
SELECT * FROM calculated`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    dialect,
    'a CAST operand in a later derived-table branch has Hover and a definition after an earlier placeholder',
    `SELECT *
FROM (
  SELECT control_text FROM source_two WHERE control_text = '$run_date'
) AS filtered
JOIN (
  SELECT CAST(target_num AS DOUBLE) AS parsed_value, target_num FROM source_table
) AS calculated ON filtered.control_text = calculated.target_num`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    dialect,
    'a CAST operand in WHERE has Hover and a definition after an earlier placeholder predicate',
    `SELECT control_text
FROM source_table
WHERE '$run_date' <> '' AND CAST(target_num AS DOUBLE) > 0`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    dialect,
    'a qualified CAST operand in JOIN ON has Hover and a definition after an earlier placeholder predicate',
    `SELECT s.control_text
FROM source_table AS s
JOIN source_two AS t
  ON '$run_date' <> '' AND CAST(t.target_num AS DOUBLE) = s.target_num`,
    'CAST(t.target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    dialect,
    'a CAST operand in ORDER BY has Hover and a definition after an earlier placeholder projection',
    `SELECT '$run_date' AS batch_marker, control_text
FROM source_table
ORDER BY CAST(target_num AS DOUBLE)`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    dialect,
    'a CAST operand has Hover and a definition after an earlier placeholder in a comment',
    `SELECT /* $run_date */ CAST(target_num AS DOUBLE) AS parsed_value, target_num
FROM source_table`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
]);

const nestedCastPlaceholderCases: NavigationCase[] = [
  ...(['spark', 'hive', 'impala'] as const).map((dialect) => placeholderColumnCase(
    dialect,
    'a nested SPLIT/subscript/CAST operand has Hover and a definition after an earlier adjacent placeholder pair',
    `SELECT '$date$hour' AS batch_marker,
  COALESCE(CAST(SPLIT(target_text, ',')[0] AS DOUBLE), -1.0) AS parsed_value,
  target_text
FROM source_table`,
    "SPLIT(target_text, ',')[0]",
    'target_text',
  )),
  placeholderColumnCase(
    'flink',
    'a nested SPLIT/subscript/CAST operand has Hover and a definition after an earlier adjacent placeholder pair',
    `SELECT '$date$hour' AS batch_marker,
  COALESCE(CAST(SPLIT(target_text, ',')[1] AS DOUBLE), -1.0) AS parsed_value,
  target_text
FROM source_table`,
    "SPLIT(target_text, ',')[1]",
    'target_text',
  ),
  placeholderColumnCase(
    'spark',
    'a CAST operand after an earlier braced placeholder has Hover and a definition',
    `SELECT '\${run_date}' AS batch_marker,
  CAST(target_num AS DOUBLE) AS parsed_value,
  target_num
FROM source_table`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    'spark',
    'a CAST to a parameterized complex type retains operand navigation after an earlier placeholder',
    `SELECT '$run_date' AS batch_marker,
  CAST(target_text AS ARRAY<STRING>) AS parsed_value,
  target_text
FROM source_table`,
    'CAST(target_text AS ARRAY<STRING>)',
    'target_text',
  ),
];

const placeholderPositionControls: NavigationCase[] = SQL_DIALECTS.flatMap((dialect) => [
  placeholderColumnCase(
    dialect,
    'a CAST operand before a later placeholder still has Hover and a definition',
    `SELECT CAST(target_num AS DOUBLE) AS parsed_value,
  '$run_date' AS batch_marker
FROM source_table`,
    'CAST(target_num AS DOUBLE)',
    'target_num',
  ),
  placeholderColumnCase(
    dialect,
    'a direct column after an earlier placeholder still has Hover and a definition',
    `SELECT '$run_date' AS batch_marker, target_num
FROM source_table`,
    'target_num',
    'target_num',
  ),
]);

const dmlCases: NavigationCase[] = [
  ...(['hive', 'postgresql', 'impala'] as const).map((dialect) => columnCase(
    dialect,
    'a CTE before INSERT retains source-column navigation',
    `WITH c AS (
  SELECT control_text, target_text AS cte_value, target_num FROM source_table
)
INSERT INTO destination
SELECT control_text, cte_value, target_num FROM c`,
    'target_text AS cte_value',
    'target_text',
  )),
  columnCase(
    'postgresql',
    'an UPDATE RETURNING column has Hover and a definition',
    'UPDATE source_table SET target_num = target_num + 1 RETURNING target_text',
    'RETURNING target_text',
    'target_text',
  ),
  columnCase(
    'postgresql',
    'an UPDATE FROM value column has Hover and a definition',
    updateFromSql,
    's.target_num',
    'target_num',
  ),
  columnCase(
    'postgresql',
    'an UPDATE FROM predicate column has Hover and a definition',
    updateFromSql,
    's.control_text',
    'control_text',
  ),
  {
    dialect: 'postgresql',
    name: 'an UPDATE FROM source relation has Hover and a definition',
    sql: updateFromSql,
    target: 'source_two AS s',
    targetWithin: 'source_two',
    expectedKind: 'table',
    expectedName: 'source_two',
  },
  columnCase(
    'postgresql',
    'an INSERT RETURNING column has Hover and a definition',
    `INSERT INTO destination (control_text, target_text, target_num)
SELECT control_text, target_text, target_num FROM source_table
RETURNING target_text`,
    'RETURNING target_text',
    'target_text',
  ),
  columnCase(
    'postgresql',
    'an ON CONFLICT key column has Hover and a definition',
    `INSERT INTO destination (control_text, target_text, target_num)
VALUES ('x', 'y', 1)
ON CONFLICT (control_text) DO NOTHING`,
    'ON CONFLICT (control_text)',
    'control_text',
  ),
  columnCase(
    'postgresql',
    'an ON CONFLICT assignment target has Hover and a definition',
    `INSERT INTO destination (control_text, target_text, target_num)
VALUES ('x', 'y', 1)
ON CONFLICT (control_text) DO UPDATE SET target_text = 'updated'`,
    "SET target_text = 'updated'",
    'target_text',
  ),
  columnCase(
    'postgresql',
    'an ON CONFLICT EXCLUDED value has Hover and a definition',
    `INSERT INTO destination (control_text, target_text, target_num)
VALUES ('x', 'y', 1)
ON CONFLICT (control_text) DO UPDATE SET target_text = EXCLUDED.target_text`,
    'EXCLUDED.target_text',
    'target_text',
  ),
  columnCase(
    'postgresql',
    'a CTE before UPDATE retains source-column navigation',
    `WITH c AS (SELECT target_text AS cte_value, control_text FROM source_two)
UPDATE source_table AS t
SET target_text = c.cte_value
FROM c
WHERE t.control_text = c.control_text`,
    'target_text AS cte_value',
    'target_text',
  ),
  columnCase(
    'postgresql',
    'a CTE before DELETE retains source-column navigation',
    `WITH c AS (SELECT target_text AS cte_value, control_text FROM source_two)
DELETE FROM source_table AS t
USING c
WHERE t.control_text = c.control_text`,
    'target_text AS cte_value',
    'target_text',
  ),
  columnCase(
    'postgresql',
    'a CTE before MERGE retains source-column navigation',
    `WITH c AS (SELECT target_text AS cte_value, control_text FROM source_two)
MERGE INTO destination AS d
USING c ON d.control_text = c.control_text
WHEN MATCHED THEN UPDATE SET target_text = c.cte_value`,
    'target_text AS cte_value',
    'target_text',
  ),
  columnCase(
    'mysql',
    'an UPDATE JOIN value column has Hover and a definition',
    mysqlUpdateJoinSql,
    's.target_num',
    'target_num',
  ),
  columnCase(
    'mysql',
    'an UPDATE JOIN predicate column has Hover and a definition',
    mysqlUpdateJoinSql,
    's.target_text',
    'target_text',
  ),
  columnCase(
    'mysql',
    'an UPDATE JOIN ON column has Hover and a definition',
    mysqlUpdateJoinSql,
    's.control_text',
    'control_text',
  ),
  {
    dialect: 'mysql',
    name: 'an UPDATE JOIN source relation has Hover and a definition',
    sql: mysqlUpdateJoinSql,
    target: 'source_two AS s',
    targetWithin: 'source_two',
    expectedKind: 'table',
    expectedName: 'source_two',
  },
  columnCase(
    'mysql',
    'an UPDATE ORDER BY column has Hover and a definition',
    'UPDATE source_table SET target_num = target_num + 1 ORDER BY target_text LIMIT 1',
    'ORDER BY target_text',
    'target_text',
  ),
  columnCase(
    'mysql',
    'an ON DUPLICATE KEY assignment target has Hover and a definition',
    `INSERT INTO destination (control_text, target_text, target_num)
VALUES ('x', 'y', 1)
ON DUPLICATE KEY UPDATE target_text = 'updated'`,
    "UPDATE target_text = 'updated'",
    'target_text',
  ),
  columnCase(
    'mysql',
    'a CTE before UPDATE retains source-column navigation',
    `WITH c AS (SELECT target_text AS cte_value, control_text FROM source_two)
UPDATE source_table AS t
JOIN c ON t.control_text = c.control_text
SET t.target_text = c.cte_value`,
    'target_text AS cte_value',
    'target_text',
  ),
  columnCase(
    'mysql',
    'a CTE before DELETE retains source-column navigation',
    `WITH c AS (SELECT target_text AS cte_value, control_text FROM source_two)
DELETE t
FROM source_table AS t
JOIN c ON t.control_text = c.control_text`,
    'target_text AS cte_value',
    'target_text',
  ),
];

describe('round five navigation controls', () => {
  it.each(SQL_DIALECTS)('%s: a direct schema column still has Hover and a definition', (dialect) => {
    expectNavigation(columnCase(
      dialect,
      'direct schema-column control',
      'SELECT target_text FROM source_table',
      'target_text',
      'target_text',
    ));
  });

  it.each(placeholderPositionControls)('$dialect: $name', (testCase) => {
    expectNavigation(testCase);
  });
});

// Regressions for columns on a set-operation root or a CTE owned by that root.
describe('round five set-operation navigation regressions', () => {
  it.each(setOperationCases)('$dialect: $name', (testCase) => {
    expectNavigation(testCase);
  });
});

// SELECT child expressions and relation decorations must reach the shared model.
describe('round five SELECT-clause navigation regressions', () => {
  it.each(selectClauseCases)('$dialect: $name', (testCase) => {
    expectNavigation(testCase);
  });
});

// DML clauses and leading CTEs that previously lost their navigation scope.
describe('round five DML navigation regressions', () => {
  it.each(dmlCases)('$dialect: $name', (testCase) => {
    expectNavigation(testCase);
  });
});

// Minimized, anonymous reproductions for the original provider failure.
// INSERT is not required: when a placeholder occurs earlier in the same SQL
// statement, incorrect CAST ranges used to overlap it and suppress traversal.
// A later placeholder and a direct column after an earlier placeholder are
// controls above. The regressions cover
// projections, CTEs, derived tables, predicates, joins, ordering, comments, and
// every supported dialect.
describe('round five placeholder INSERT navigation regressions', () => {
  it.each(placeholderInsertCases)('$dialect: $name', (testCase) => {
    expectNavigation(testCase);
  });
});

describe('round five earlier-placeholder CAST navigation regressions', () => {
  it.each([...placeholderBeforeCastCases, ...nestedCastPlaceholderCases])('$dialect: $name', (testCase) => {
    expectNavigation(testCase);
  });
});
