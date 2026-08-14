import { describe, expect, it } from 'vitest';

import { getSqlCatalog } from '../../src/sqlCatalog';
import {
  analyzeSqlSemantics,
  collectSqlFieldNames,
  createSchemaSnapshot,
  getSqlSchemaAtOffset,
  getSqlScopeInfo,
  parseDdlSchema,
} from '../../src/sqlSchemaCore';
import { SQL_DIALECTS, type SqlDialect } from '../../src/sql';

const ddlByDialect: Record<SqlDialect, string> = {
  spark: 'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id STRING);',
  hive: 'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id STRING);',
  flink: "CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id STRING) WITH ('connector'='values');",
  mysql: 'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id VARCHAR(100));',
  postgresql: 'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id VARCHAR(100));',
  trino: 'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id VARCHAR);',
  impala: 'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id STRING);',
  generic: 'CREATE TABLE sales.orders (id BIGINT, amount DECIMAL(10,2), customer_id VARCHAR(100));',
};

describe('SQL catalogs', () => {
  it.each(SQL_DIALECTS)('contains keywords and built-in functions for %s', (dialect) => {
    const catalog = getSqlCatalog(dialect);
    expect(catalog.keywords).toContain('SELECT');
    expect(catalog.functions.length).toBeGreaterThan(5);
  });

  it('contains representative dialect-specific functions', () => {
    expect(getSqlCatalog('spark').functions).toContain('ARRAYS_ZIP');
    expect(getSqlCatalog('flink').functions).toContain('CURRENT_WATERMARK');
    expect(getSqlCatalog('mysql').functions).toContain('JSON_TABLE');
    expect(getSqlCatalog('postgresql').functions).toContain('TO_REGCLASS');
    expect(getSqlCatalog('trino').functions).toContain('ZIP_WITH');
  });
});

describe('DDL schema extraction', () => {
  it.each(SQL_DIALECTS)('extracts explicit columns for %s', (dialect) => {
    const result = parseDdlSchema(ddlByDialect[dialect], dialect, `${dialect}.sql`);
    expect(result.issues).toEqual([]);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.name).toBe('sales.orders');
    expect(result.tables[0]?.columns.map((column) => column.name)).toEqual(['id', 'amount', 'customer_id']);
  });

  it('rejects invalid DDL and duplicate table definitions', () => {
    const invalid = parseDdlSchema('CREATE TABLE broken (', 'spark', 'broken.sql');
    expect(invalid.tables).toEqual([]);
    expect(invalid.issues.length).toBeGreaterThan(0);

    const first = parseDdlSchema('CREATE TABLE orders (id BIGINT);', 'spark', 'one.sql');
    const second = parseDdlSchema('CREATE TABLE orders (id BIGINT);', 'spark', 'two.sql');
    const snapshot = createSchemaSnapshot([first, second]);
    expect(snapshot.tables).toEqual([]);
    expect(snapshot.issues.filter((issue) => issue.code === 'duplicate-schema-table')).toHaveLength(2);
  });

  it('merges views declaratively across schema files and ignores DROP statements', () => {
    const views = parseDdlSchema(
      'CREATE VIEW sales.order_ids AS SELECT id FROM sales.orders; DROP TABLE sales.orders;',
      'spark',
      'views.sql',
    );
    const tables = parseDdlSchema('CREATE TABLE sales.orders (id BIGINT);', 'spark', 'tables.sql');
    const snapshot = createSchemaSnapshot([views, tables]);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.tables.map((table) => `${table.kind}:${table.name}`)).toEqual([
      'table:sales.orders',
      'view:sales.order_ids',
    ]);
    expect(snapshot.tables[1]?.columns.map((column) => column.name)).toEqual(['id']);
  });

  it('reports unresolved and duplicate schema views', () => {
    const unresolved = parseDdlSchema(
      'CREATE VIEW first_view AS SELECT * FROM second_view; CREATE VIEW second_view AS SELECT * FROM first_view;',
      'spark',
      'cycle.sql',
    );
    expect(createSchemaSnapshot([unresolved]).issues.filter((issue) => (
      issue.code === 'schema-view-unresolved'
    ))).toHaveLength(2);

    const duplicate = createSchemaSnapshot([
      parseDdlSchema('CREATE TABLE object_name (id BIGINT);', 'spark', 'table.sql'),
      parseDdlSchema('CREATE VIEW object_name AS SELECT 1 AS id;', 'spark', 'view.sql'),
    ]);
    expect(duplicate.tables).toEqual([]);
    expect(duplicate.issues.filter((issue) => issue.code === 'duplicate-schema-object')).toHaveLength(2);
  });
});

describe('offline SQL schema validation', () => {
  const schema = createSchemaSnapshot([
    parseDdlSchema(ddlByDialect.spark, 'spark', 'orders.sql'),
    parseDdlSchema('CREATE TABLE sales.customers (id BIGINT, name STRING);', 'spark', 'customers.sql'),
  ]);

  it('accepts known joined fields and registered UDFs', () => {
    const sql = `SELECT o.id, c.name, score_udf(o.amount)
FROM sales.orders o JOIN sales.customers c ON o.customer_id = c.id
WHERE o.amount > 0`;
    expect(analyzeSqlSemantics(sql, 'spark', [], schema, ['score_udf'])).toEqual([]);
  });

  it('reports unknown tables, columns, qualifiers, functions, and ambiguity', () => {
    expect(analyzeSqlSemantics('SELECT id FROM missing', 'spark', [], schema, []).some((issue) => (
      issue.code === 'unknown-table'
    ))).toBe(true);
    expect(analyzeSqlSemantics('SELECT o.missing FROM sales.orders o', 'spark', [], schema, []).some((issue) => (
      issue.code === 'unknown-column'
    ))).toBe(true);
    expect(analyzeSqlSemantics('SELECT x.id FROM sales.orders o', 'spark', [], schema, []).some((issue) => (
      issue.code === 'unknown-qualifier'
    ))).toBe(true);
    expect(analyzeSqlSemantics('SELECT mystery(id) FROM sales.orders', 'spark', [], schema, []).some((issue) => (
      issue.code === 'unknown-function' && issue.severity === 'warning'
    ))).toBe(true);
    expect(analyzeSqlSemantics(
      'SELECT id FROM sales.orders o JOIN sales.customers c ON o.customer_id = c.id',
      'spark',
      [],
      schema,
      [],
    ).some((issue) => issue.code === 'ambiguous-column')).toBe(true);
  });

  it('uses the parse-tree adapters consistently for every dialect', () => {
    for (const dialect of SQL_DIALECTS) {
      const dialectSchema = createSchemaSnapshot([
        parseDdlSchema(ddlByDialect[dialect], dialect, `${dialect}.sql`),
      ]);
      expect(analyzeSqlSemantics('SELECT id FROM sales.orders', dialect, [], dialectSchema, [])).toEqual([]);
      expect(analyzeSqlSemantics(
        'SELECT missing FROM sales.orders',
        dialect,
        [],
        dialectSchema,
        [],
      ).some((issue) => issue.code === 'unknown-column')).toBe(true);
      expect(analyzeSqlSemantics(
        'SELECT mystery(id) FROM sales.orders',
        dialect,
        [],
        dialectSchema,
        [],
      ).some((issue) => issue.code === 'unknown-function' && issue.severity === 'warning')).toBe(true);
    }
  });

  it('resolves CTE and subquery projection fields', () => {
    const cte = 'WITH recent AS (SELECT id, amount AS total FROM sales.orders) SELECT r.id, r.total FROM recent r';
    expect(analyzeSqlSemantics(cte, 'spark', [], schema, [])).toEqual([]);
    const subquery = 'SELECT s.id FROM (SELECT id FROM sales.orders WHERE amount > 0) s';
    expect(analyzeSqlSemantics(subquery, 'spark', [], schema, [])).toEqual([]);
  });

  it('suppresses references covered by placeholders', () => {
    expect(analyzeSqlSemantics(
      'SELECT ${field} FROM sales.orders',
      'spark',
      [/\$\{[^}]+\}/gu],
      schema,
      [],
    )).toEqual([]);
  });

  it('keeps known CTE fields available beside dynamic projections and relations', () => {
    const sql = "WITH valid_data AS (SELECT ${othercols}, e, FROM ${tablename}) "
      + "SELECT $othercols2, concat_ws('_', a, b) AS c, d, e FROM valid_data";
    const placeholders = [/\$\{[^}]+\}/gu, /\$\w+/gu];

    expect(analyzeSqlSemantics(sql, 'spark', placeholders, { tables: [], issues: [] }, [])).toEqual([]);
    const outerField = getSqlScopeInfo(sql, sql.lastIndexOf(', e') + 2, 'spark', placeholders, {
      tables: [],
      issues: [],
    });
    expect(outerField.fields).toContain('e');
  });

  it('checks INSERT, UNION, and simple UPDATE shapes when types are known', () => {
    expect(analyzeSqlSemantics(
      'INSERT INTO sales.orders (id, amount) SELECT id FROM sales.customers',
      'spark',
      [],
      schema,
      [],
    ).some((issue) => issue.code === 'insert-column-count')).toBe(true);
    expect(analyzeSqlSemantics(
      'INSERT INTO sales.orders (id) SELECT name FROM sales.customers',
      'spark',
      [],
      schema,
      [],
    ).some((issue) => issue.code === 'incompatible-type')).toBe(true);
    expect(analyzeSqlSemantics(
      'SELECT id FROM sales.orders UNION ALL SELECT id, name FROM sales.customers',
      'spark',
      [],
      schema,
      [],
    ).some((issue) => issue.code === 'union-column-count')).toBe(true);
    expect(analyzeSqlSemantics(
      "UPDATE sales.orders SET amount = 'bad' WHERE id = 1",
      'spark',
      [],
      schema,
      [],
    ).some((issue) => issue.code === 'incompatible-type')).toBe(true);
  });

  it('validates parenthesized INSERT SELECT sources', () => {
    const invalid = 'CREATE TABLE t1 (a INT); INSERT INTO t1 (SELECT b FROM t1);';
    const issues = analyzeSqlSemantics(invalid, 'spark', [], { tables: [], issues: [] }, []);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown-column',
        start: invalid.indexOf('b FROM'),
      }),
    ]));

    expect(analyzeSqlSemantics(
      'CREATE TABLE t1 (a INT); INSERT INTO t1 (SELECT a FROM t1);',
      'spark',
      [],
      { tables: [], issues: [] },
      [],
    )).toEqual([]);
  });

  it('collects current-file fields and returns schema fields in scope', () => {
    const sql = 'SELECT o.id, o.amount AS total FROM sales.orders o WHERE o.customer_id > 0';
    expect(collectSqlFieldNames(sql, 'spark', [])).toEqual(['id', 'amount', 'customer_id']);
    const scope = getSqlScopeInfo(sql, sql.indexOf('o.amount'), 'spark', [], schema);
    expect(scope.fields).toEqual(['id', 'amount', 'customer_id']);
  });

  it('accepts Spark SET and explicit CREATE TABLE statements without scanning DDL identifiers', () => {
    expect(analyzeSqlSemantics('set spark.sql.ansi.enabled = true;', 'spark', [], schema, [])).toEqual([]);
    expect(analyzeSqlSemantics('CREATE TABLE local_table (id BIGINT, name STRING);', 'spark', [], schema, [])).toEqual([]);
  });

  it('applies local table creation and deletion in source order', () => {
    const sql = `SELECT id FROM local_table;
CREATE TABLE local_table (id BIGINT);
SELECT id FROM local_table;
DROP TABLE local_table;
SELECT id FROM local_table;`;
    const issues = analyzeSqlSemantics(sql, 'spark', [], schema, []);
    expect(issues.filter((issue) => issue.code === 'unknown-table')).toHaveLength(2);
    expect(issues.some((issue) => issue.code === 'unknown-column')).toBe(false);

    const beforeCreate = sql.indexOf('CREATE TABLE');
    const afterCreate = sql.indexOf('SELECT id FROM local_table;', beforeCreate);
    const afterDrop = sql.lastIndexOf('SELECT id FROM local_table;');
    expect(getSqlSchemaAtOffset(sql, beforeCreate, 'spark', [], schema).tables.some((table) => (
      table.name === 'local_table'
    ))).toBe(false);
    expect(getSqlSchemaAtOffset(sql, afterCreate, 'spark', [], schema).tables.some((table) => (
      table.name === 'local_table'
    ))).toBe(true);
    expect(getSqlSchemaAtOffset(sql, afterDrop, 'spark', [], schema).tables.some((table) => (
      table.name === 'local_table'
    ))).toBe(false);
  });

  it('enforces local DDL conflicts and IF EXISTS semantics', () => {
    expect(analyzeSqlSemantics(
      'CREATE TABLE sales.orders (local_id BIGINT);',
      'spark',
      [],
      schema,
      [],
    ).some((issue) => issue.code === 'duplicate-local-object')).toBe(true);
    expect(analyzeSqlSemantics(
      'CREATE TABLE IF NOT EXISTS sales.orders (local_id BIGINT);',
      'spark',
      [],
      schema,
      [],
    )).toEqual([]);
    expect(analyzeSqlSemantics('DROP TABLE absent;', 'spark', [], schema, []).some((issue) => (
      issue.code === 'unknown-drop-object'
    ))).toBe(true);
    expect(analyzeSqlSemantics('DROP TABLE IF EXISTS absent;', 'spark', [], schema, [])).toEqual([]);
  });

  it('lets temporary objects shadow and then restore global objects', () => {
    const sql = `CREATE TEMPORARY TABLE sales.orders (local_id BIGINT);
SELECT local_id FROM sales.orders;
DROP TABLE sales.orders;
SELECT id FROM sales.orders;`;
    expect(analyzeSqlSemantics(sql, 'spark', [], schema, [])).toEqual([]);
  });

  it('creates and drops inferred local views in source order', () => {
    const sql = `CREATE VIEW local_orders AS SELECT id, amount AS total FROM sales.orders;
SELECT id, total FROM local_orders;
DROP VIEW local_orders;
SELECT id FROM local_orders;`;
    const issues = analyzeSqlSemantics(sql, 'spark', [], schema, []);
    expect(issues.filter((issue) => issue.code === 'unknown-table')).toHaveLength(1);
    expect(issues.some((issue) => issue.code === 'unknown-column')).toBe(false);
    expect(analyzeSqlSemantics(
      'CREATE VIEW bad_view AS SELECT missing FROM sales.orders;',
      'spark',
      [],
      schema,
      [],
    ).some((issue) => issue.code === 'unknown-column')).toBe(true);
  });

  it('accepts Spark quoted identifiers, complex expressions, generators, partitions, and implicit aliases', () => {
    const cases = [
      'create table test_table (`a` string); select a from test_table;',
      'create table test_table (a string); select `a` from test_table;',
      "create table test_table (a string); select from_json(a, 'struct<x:int,y:int>').x from test_table;",
      "create table test_table (a string); select pos, exp_obj.x, exp_obj.y from test_table lateral view outer posexplode (from_json(test_table.a, 'array<struct<x:string,y:string>>')) test_table_exp as pos, exp_obj;",
      "create table test_table (a string) partitioned by (`pt_h` string); insert into test_table partition (pt_h = '$date$hour') values ('x');",
      "create table test_table (a string); select struct(a).a, named_struct('x', a).x from test_table;",
      "create table test_table (a string); select size(split(a, ',')) from test_table;",
      'create table test_table (a string); select a b from test_table;',
      "create table test_table (a string); select pos, key, value from test_table lateral view posexplode(from_json(a, 'map<string,int>')) expanded as pos, key, value;",
    ];
    for (const sql of cases) {
      expect(analyzeSqlSemantics(sql, 'spark', [], { tables: [], issues: [] }, [])).toEqual([]);
    }
  });

  it('retains nested-field errors when a complex type is known', () => {
    const cases = [
      "create table test_table (a string); select from_json(a, 'struct<x:int>').missing from test_table;",
      "create table test_table (a string); select named_struct('x', a).missing from test_table;",
      "create table test_table (a string); select exp_obj.missing from test_table lateral view posexplode(from_json(a, 'array<struct<x:string>>')) expanded as pos, exp_obj;",
    ];
    for (const sql of cases) {
      expect(analyzeSqlSemantics(sql, 'spark', [], { tables: [], issues: [] }, []).some((issue) => (
        issue.code === 'unknown-column'
      ))).toBe(true);
    }
  });

  it('adds partition columns to local schemas and excludes static partitions from INSERT payloads', () => {
    const sql = "CREATE TABLE partitioned_table (a STRING) PARTITIONED BY (`pt_h` STRING); INSERT INTO partitioned_table PARTITION (pt_h = '$date$hour') VALUES ('x');";
    const snapshot = getSqlSchemaAtOffset(sql, sql.length, 'spark', [], { tables: [], issues: [] });
    expect(snapshot.tables[0]?.columns.map((column) => column.name)).toEqual(['a', 'pt_h']);
    expect(analyzeSqlSemantics(sql, 'spark', [], { tables: [], issues: [] }, [])).toEqual([]);
  });

  it('suppresses relation and dependent column diagnostics for dynamic relation names', () => {
    const placeholders = [/\$\{[^}]+\}/gu];
    const cases = [
      'SELECT a FROM ${param:db}.${param:table}',
      'SELECT a FROM analytics.${param:table}',
      'SELECT d.a FROM static_${param:db}.${param:table} d',
    ];
    for (const sql of cases) {
      expect(analyzeSqlSemantics(sql, 'spark', placeholders, schema, [])).toEqual([]);
    }
  });
});
