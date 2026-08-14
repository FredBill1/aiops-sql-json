import { describe, expect, it } from 'vitest';

import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  parseDdlSchema,
} from '../../src/sqlSchemaCore';

interface ValidSparkSemanticCase {
  name: string;
  ddl: string;
  sql: string;
}

const staticPartitionCases: readonly ValidSparkSemanticCase[] = [
  {
    name: 'reported parenthesized INSERT OVERWRITE TABLE SELECT reproduction',
    ddl: '',
    sql: `CREATE TABLE test_table (a STRING) PARTITIONED BY (pt STRING);
INSERT OVERWRITE TABLE test_table PARTITION (pt = 'pt1') (SELECT 1 AS a);`,
  },
  {
    name: 'INSERT OVERWRITE without the optional TABLE keyword',
    ddl: 'CREATE TABLE target_table (a STRING) PARTITIONED BY (pt STRING);',
    sql: "INSERT OVERWRITE target_table PARTITION (pt = 'pt1') SELECT 'value' AS a",
  },
  {
    name: 'INSERT OVERWRITE TABLE with an unparenthesized SELECT',
    ddl: 'CREATE TABLE target_table (a STRING) PARTITIONED BY (pt STRING);',
    sql: "INSERT OVERWRITE TABLE target_table PARTITION (pt = 'pt1') SELECT 'value' AS a",
  },
  {
    name: 'INSERT OVERWRITE static partition with VALUES',
    ddl: 'CREATE TABLE target_table (a STRING) PARTITIONED BY (pt STRING);',
    sql: "INSERT OVERWRITE target_table PARTITION (pt = 'pt1') VALUES ('value')",
  },
  {
    name: 'INSERT OVERWRITE with two static partition columns',
    ddl: 'CREATE TABLE target_table (a STRING) PARTITIONED BY (day DATE, region STRING);',
    sql: "INSERT OVERWRITE target_table PARTITION (day = DATE'2026-08-14', region = 'ie') SELECT 'value' AS a",
  },
  {
    name: 'INSERT OVERWRITE with a typed static partition literal',
    ddl: 'CREATE TABLE target_table (name STRING, address STRING) PARTITIONED BY (birthday DATE);',
    sql: `INSERT OVERWRITE target_table PARTITION (birthday = DATE'2019-01-02')
VALUES ('Jason Wang', '908 Bird St, Saratoga')`,
  },
  {
    name: 'INSERT OVERWRITE with a NULL static partition value',
    ddl: 'CREATE TABLE target_table (a STRING) PARTITIONED BY (pt STRING);',
    sql: "INSERT OVERWRITE target_table PARTITION (pt = NULL) SELECT 'value' AS a",
  },
  {
    name: 'INSERT OVERWRITE TABLE with a templated static partition value',
    ddl: 'CREATE TABLE target_table (a STRING) PARTITIONED BY (pt STRING);',
    sql: "INSERT OVERWRITE TABLE target_table PARTITION (pt = '$date$hour') VALUES ('value')",
  },
  {
    name: 'INSERT OVERWRITE into quoted qualified table and partition names',
    ddl: 'CREATE TABLE `analytics`.`target_table` (`a` STRING) PARTITIONED BY (`select` STRING);',
    sql: "INSERT OVERWRITE TABLE `analytics`.`target_table` PARTITION (`select` = 'pt1') SELECT 'value' AS `a`",
  },
  {
    name: 'INSERT OVERWRITE into a data source table partitioned by an existing column',
    ddl: 'CREATE TABLE target_table (a STRING, pt STRING) USING PARQUET PARTITIONED BY (pt);',
    sql: "INSERT OVERWRITE target_table PARTITION (pt = 'pt1') SELECT 'value' AS a",
  },
  {
    name: 'INSERT OVERWRITE static partition sourced from a CTE',
    ddl: 'CREATE TABLE target_table (a STRING) PARTITIONED BY (pt STRING);',
    sql: `INSERT OVERWRITE target_table PARTITION (pt = 'pt1')
WITH source_data AS (SELECT 'value' AS a)
SELECT a FROM source_data`,
  },
  {
    name: 'INSERT OVERWRITE static partition sourced from a FROM query',
    ddl: `CREATE TABLE target_table (a STRING) PARTITIONED BY (pt STRING);
CREATE TABLE source_table (a STRING, active BOOLEAN);`,
    sql: `INSERT OVERWRITE target_table PARTITION (pt = 'pt1')
FROM source_table SELECT a WHERE active = TRUE`,
  },
  {
    name: 'INSERT OVERWRITE combines a static partition and recursive store assignment',
    ddl: 'CREATE TABLE target_table (value ARRAY<STRING>) PARTITIONED BY (pt STRING);',
    sql: "INSERT OVERWRITE target_table PARTITION (pt = 'pt1') SELECT ARRAY(1) AS value",
  },
];

const storeAssignmentCases: readonly ValidSparkSemanticCase[] = [
  {
    name: 'numeric literal into STRING',
    ddl: 'CREATE TABLE target_table (value STRING);',
    sql: 'INSERT INTO target_table SELECT 1 AS value',
  },
  {
    name: 'numeric column into STRING',
    ddl: 'CREATE TABLE source_table (value BIGINT); CREATE TABLE target_table (value STRING);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'DATE column into STRING',
    ddl: 'CREATE TABLE source_table (value DATE); CREATE TABLE target_table (value STRING);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'STRING column into TIME',
    ddl: 'CREATE TABLE source_table (value STRING); CREATE TABLE target_table (value TIME);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'BOOLEAN column into STRING',
    ddl: 'CREATE TABLE source_table (value BOOLEAN); CREATE TABLE target_table (value STRING);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'BINARY column into STRING',
    ddl: 'CREATE TABLE source_table (value BINARY); CREATE TABLE target_table (value STRING);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'ARRAY element numeric into STRING',
    ddl: 'CREATE TABLE source_table (value ARRAY<INT>); CREATE TABLE target_table (value ARRAY<STRING>);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'MAP value numeric into STRING',
    ddl: 'CREATE TABLE source_table (value MAP<STRING,INT>); CREATE TABLE target_table (value MAP<STRING,STRING>);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'STRUCT field numeric into STRING',
    ddl: 'CREATE TABLE source_table (value STRUCT<id:INT>); CREATE TABLE target_table (value STRUCT<id:STRING>);',
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'nested ARRAY STRUCT field numeric into STRING',
    ddl: `CREATE TABLE source_table (value ARRAY<STRUCT<id:INT>>);
CREATE TABLE target_table (value ARRAY<STRUCT<id:STRING>>);`,
    sql: 'INSERT INTO target_table SELECT value FROM source_table',
  },
  {
    name: 'ARRAY constructor element numeric into STRING',
    ddl: 'CREATE TABLE target_table (value ARRAY<STRING>);',
    sql: 'INSERT INTO target_table SELECT ARRAY(1) AS value',
  },
  {
    name: 'MAP expression value numeric into STRING',
    ddl: 'CREATE TABLE target_table (value MAP<STRING,STRING>);',
    sql: `INSERT INTO target_table
SELECT CAST(MAP('id', 1) AS MAP<STRING,INT>) AS value`,
  },
  {
    name: 'named STRUCT constructor field numeric into STRING',
    ddl: 'CREATE TABLE target_table (value STRUCT<id:STRING>);',
    sql: "INSERT INTO target_table SELECT NAMED_STRUCT('id', 1) AS value",
  },
  {
    name: 'STRUCT constructor field numeric into STRING',
    ddl: 'CREATE TABLE target_table (value STRUCT<id:STRING>);',
    sql: 'INSERT INTO target_table SELECT STRUCT(1 AS id) AS value',
  },
  {
    name: 'numeric literal into STRING through an explicit target column list',
    ddl: 'CREATE TABLE target_table (id BIGINT, label STRING);',
    sql: 'INSERT INTO target_table (label) SELECT 1 AS label',
  },
  {
    name: 'numeric literal into STRING beside a static partition',
    ddl: 'CREATE TABLE target_table (label STRING) PARTITIONED BY (pt STRING);',
    sql: "INSERT INTO target_table PARTITION (pt = 'pt1') SELECT 1 AS label",
  },
  {
    name: 'numeric literal into STRING through VALUES',
    ddl: 'CREATE TABLE target_table (label STRING);',
    sql: 'INSERT INTO target_table VALUES (1)',
  },
  {
    name: 'BOOLEAN literal into STRING',
    ddl: 'CREATE TABLE target_table (label STRING);',
    sql: 'INSERT INTO target_table SELECT TRUE AS label',
  },
  {
    name: 'numeric literal into VARCHAR',
    ddl: 'CREATE TABLE target_table (label VARCHAR(20));',
    sql: 'INSERT INTO target_table SELECT 1 AS label',
  },
  {
    name: 'numeric arithmetic expression into STRING',
    ddl: 'CREATE TABLE target_table (label STRING);',
    sql: 'INSERT INTO target_table SELECT 1 + 2 AS label',
  },
  {
    name: 'STRING literal into INT with LEGACY store assignment',
    ddl: 'CREATE TABLE target_table (value INT);',
    sql: `SET spark.sql.storeAssignmentPolicy = LEGACY;
INSERT INTO target_table VALUES ('1')`,
  },
];

const byNameCases: readonly ValidSparkSemanticCase[] = [
  {
    name: 'INSERT INTO BY NAME reorders query outputs',
    ddl: `CREATE TABLE source_table (bytes BINARY, active BOOLEAN);
CREATE TABLE target_table (active BOOLEAN, bytes BINARY);`,
    sql: 'INSERT INTO target_table BY NAME SELECT bytes, active FROM source_table',
  },
  {
    name: 'INSERT OVERWRITE BY NAME reorders query outputs',
    ddl: `CREATE TABLE source_table (bytes BINARY, active BOOLEAN);
CREATE TABLE target_table (active BOOLEAN, bytes BINARY);`,
    sql: 'INSERT OVERWRITE target_table BY NAME SELECT bytes, active FROM source_table',
  },
  {
    name: 'INSERT OVERWRITE static partition BY NAME reorders query outputs',
    ddl: `CREATE TABLE source_table (bytes BINARY, active BOOLEAN);
CREATE TABLE target_table (active BOOLEAN, bytes BINARY) PARTITIONED BY (pt STRING);`,
    sql: `INSERT OVERWRITE target_table PARTITION (pt = 'pt1') BY NAME
SELECT bytes, active FROM source_table`,
  },
  {
    name: 'INSERT INTO static partition BY NAME reorders aliased expressions',
    ddl: 'CREATE TABLE target_table (active BOOLEAN, bytes BINARY) PARTITIONED BY (pt STRING);',
    sql: `INSERT INTO target_table PARTITION (pt = 'pt1') BY NAME
SELECT CAST('value' AS BINARY) AS bytes, TRUE AS active`,
  },
];

const setOperationCoercionCases: readonly ValidSparkSemanticCase[] = [
  {
    name: 'UNION ALL finds a common type for numeric and STRING scalars',
    ddl: 'CREATE TABLE numeric_values (value BIGINT); CREATE TABLE string_values (value STRING);',
    sql: `SELECT value FROM numeric_values
UNION ALL
SELECT value FROM string_values`,
  },
  {
    name: 'UNION ALL finds a common type for BOOLEAN and STRING scalars',
    ddl: 'CREATE TABLE boolean_values (value BOOLEAN); CREATE TABLE string_values (value STRING);',
    sql: `SELECT value FROM boolean_values
UNION ALL
SELECT value FROM string_values`,
  },
  {
    name: 'UNION ALL finds a common type for DATE and STRING scalars',
    ddl: 'CREATE TABLE date_values (value DATE); CREATE TABLE string_values (value STRING);',
    sql: `SELECT value FROM date_values
UNION ALL
SELECT value FROM string_values`,
  },
  {
    name: 'UNION ALL finds a common type for BINARY and STRING scalars',
    ddl: 'CREATE TABLE binary_values (value BINARY); CREATE TABLE string_values (value STRING);',
    sql: `SELECT value FROM binary_values
UNION ALL
SELECT value FROM string_values`,
  },
  {
    name: 'UNION ALL recursively coerces ARRAY element types',
    ddl: `CREATE TABLE numeric_values (value ARRAY<INT>);
CREATE TABLE string_values (value ARRAY<STRING>);`,
    sql: `SELECT value FROM numeric_values
UNION ALL
SELECT value FROM string_values`,
  },
  {
    name: 'UNION ALL recursively coerces MAP value types',
    ddl: `CREATE TABLE numeric_values (value MAP<STRING,INT>);
CREATE TABLE string_values (value MAP<STRING,STRING>);`,
    sql: `SELECT value FROM numeric_values
UNION ALL
SELECT value FROM string_values`,
  },
  {
    name: 'UNION ALL recursively coerces STRUCT field types',
    ddl: `CREATE TABLE numeric_values (value STRUCT<id:INT>);
CREATE TABLE string_values (value STRUCT<id:STRING>);`,
    sql: `SELECT value FROM numeric_values
UNION ALL
SELECT value FROM string_values`,
  },
];

const nonTableInsertCases: readonly ValidSparkSemanticCase[] = [
  {
    name: 'INSERT OVERWRITE LOCAL DIRECTORY using a VALUES query',
    ddl: '',
    sql: `INSERT OVERWRITE LOCAL DIRECTORY '/tmp/spark-insert-edge-case'
STORED AS ORC
VALUES ('value')`,
  },
  {
    name: 'INSERT OVERWRITE LOCAL DIRECTORY using a SELECT query',
    ddl: 'CREATE TABLE source_table (value STRING);',
    sql: `INSERT OVERWRITE LOCAL DIRECTORY '/tmp/spark-insert-edge-case'
STORED AS ORC
SELECT value FROM source_table`,
  },
];

// These are deliberately red acceptance tests. Every statement is valid Spark SQL and should
// produce no schema diagnostic; each case currently exposes a schema-validation false positive.
describe('Spark INSERT and type-coercion schema-validation edge cases', () => {
  describe.each([
    ['static partition handling', staticPartitionCases],
    ['store assignment coercion', storeAssignmentCases],
    ['BY NAME output matching', byNameCases],
    ['set-operation type coercion', setOperationCoercionCases],
    ['non-table INSERT targets', nonTableInsertCases],
  ] as const)('%s', (_group, cases) => {
    it.each(cases)('$name', ({ name, ddl, sql }) => {
      const parsed = ddl.trim() ? [parseDdlSchema(ddl, 'spark', `${name}.sql`)] : [];
      const schema = createSchemaSnapshot(parsed);

      expect(schema.issues).toEqual([]);
      expect(analyzeSqlSemantics(sql, 'spark', [], schema, [])).toEqual([]);
    });
  });
});
