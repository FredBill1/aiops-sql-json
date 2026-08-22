import { describe, expect, it } from 'vitest';

import { SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import {
  CURRENT_SQL_DOCUMENT_SOURCE,
  createSchemaSnapshot,
  getSqlSymbolAtOffset,
  parseDdlSchema,
} from '../../src/sqlSchemaCore';

const ddlByDialect: Record<SqlDialect, string> = {
  spark: 'CREATE TABLE sales.orders (id BIGINT, payload STRUCT<name: STRING>) USING PARQUET;',
  hive: 'CREATE TABLE sales.orders (id BIGINT, payload STRUCT<name: STRING>);',
  flink: "CREATE TABLE sales.orders (id BIGINT, payload ROW<name STRING>) WITH ('connector'='values');",
  mysql: 'CREATE TABLE sales.orders (id BIGINT, payload JSON);',
  postgresql: 'CREATE TABLE sales.orders (id BIGINT, payload JSONB);',
  trino: 'CREATE TABLE sales.orders (id BIGINT, payload ROW(name VARCHAR));',
  impala: 'CREATE TABLE sales.orders (id BIGINT, payload STRUCT<name: STRING>);',
  generic: 'CREATE TABLE sales.orders (id BIGINT, payload VARCHAR(100));',
};

function symbol(
  sql: string,
  needle: string,
  dialect: SqlDialect,
  snapshot = createSchemaSnapshot([parseDdlSchema(ddlByDialect[dialect], dialect, `file:///${dialect}.sql`)]),
  occurrence = 0,
) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) offset = sql.indexOf(needle, offset + 1);
  expect(offset).toBeGreaterThanOrEqual(0);
  return getSqlSymbolAtOffset(sql, offset, dialect, [], snapshot);
}

describe('AST SQL symbol resolver', () => {
  it.each(SQL_DIALECTS)('resolves external relation and column origins for %s', (dialect) => {
    const sql = 'SELECT o.id FROM sales.orders o';
    const table = symbol(sql, 'orders', dialect);
    const column = symbol(sql, 'id', dialect);
    const alias = symbol(sql, 'o.id', dialect);
    expect(table?.kind).toBe('table');
    expect(table?.definitions[0]?.location.source).toBe(`file:///${dialect}.sql`);
    expect(column?.kind).toBe('column');
    expect(column?.definitions[0]?.name).toBe('id');
    expect(alias?.kind).toBe('relation-alias');
    expect(alias?.definitions[0]?.location.selectionStart).toBe(sql.lastIndexOf(' o') + 1);
  });

  it('uses exact UTF-16 spans and resolves each nested STRUCT field', () => {
    const ddl = 'CREATE TABLE t (payload STRUCT<user: STRUCT<display_name: STRING>>);';
    const snapshot = createSchemaSnapshot([parseDdlSchema(ddl, 'spark', 'file:///nested.sql')]);
    const sql = '-- 😀 UTF-16\nSELECT t.payload.user.display_name FROM t';
    const resolved = symbol(sql, 'display_name', 'spark', snapshot);
    expect(resolved?.reference).toEqual({
      start: sql.indexOf('display_name'),
      end: sql.indexOf('display_name') + 'display_name'.length,
    });
    expect(resolved?.kind).toBe('field');
    expect(ddl.slice(
      resolved?.definitions[0]?.location.selectionStart,
      resolved?.definitions[0]?.location.selectionEnd,
    )).toBe('display_name');
  });

  it('follows the lexical CTE projection chain before the DDL column', () => {
    const sql = 'WITH c(out_id) AS (SELECT id AS inner_id FROM sales.orders) SELECT c.out_id FROM c';
    const snapshot = createSchemaSnapshot([parseDdlSchema(ddlByDialect.spark, 'spark', 'file:///schema.sql')]);
    const usage = symbol(sql, 'out_id', 'spark', snapshot, 1);
    expect(usage?.definitions[0]?.location.selectionStart).toBe(sql.indexOf('out_id'));

    const explicit = symbol(sql, 'out_id', 'spark', snapshot);
    expect(explicit?.definitions[0]?.location.selectionStart).toBe(sql.indexOf('inner_id'));

    const projection = symbol(sql, 'inner_id', 'spark', snapshot);
    expect(projection?.definitions[0]?.location.source).toBe('file:///schema.sql');
    expect(projection?.definitions[0]?.name).toBe('id');
  });

  it('jumps through a derived-table alias without looping on its declaration', () => {
    const snapshot = createSchemaSnapshot([parseDdlSchema(ddlByDialect.spark, 'spark', 'file:///schema.sql')]);
    const sql = 'SELECT d.x FROM (SELECT id AS x FROM sales.orders) d';
    const usage = symbol(sql, 'd.x', 'spark', snapshot);
    expect(usage?.kind).toBe('relation-alias');
    expect(usage?.definitions[0]?.location.selectionStart).toBe(sql.lastIndexOf(' d') + 1);
    const declaration = getSqlSymbolAtOffset(sql, sql.lastIndexOf(' d') + 1, 'spark', [], snapshot);
    expect(declaration?.kind).toBe('relation-alias');
    expect(declaration?.definitions[0]?.location.selectionStart).toBe(sql.indexOf('id AS'));
  });

  it('honors nested Lambda shadowing', () => {
    const snapshot = createSchemaSnapshot([parseDdlSchema('CREATE TABLE t (id BIGINT);', 'spark', 'file:///t.sql')]);
    const sql = 'SELECT transform(array(id), x -> transform(array(x), x -> x + 1)) FROM t';
    const outerUse = symbol(sql, 'x', 'spark', snapshot, 1);
    const innerUse = symbol(sql, 'x', 'spark', snapshot, 3);
    expect(outerUse?.definitions[0]?.location.selectionStart).toBe(sql.indexOf('x ->'));
    expect(innerUse?.definitions[0]?.location.selectionStart).toBe(sql.indexOf('x ->', sql.indexOf('x ->') + 1));
  });

  it('resolves explicit generator output columns and their types', () => {
    const snapshot = createSchemaSnapshot([parseDdlSchema(
      'CREATE TABLE t (items ARRAY<STRUCT<sku: STRING>>);',
      'spark',
      'file:///t.sql',
    )]);
    const sql = 'SELECT pos, item.sku FROM t LATERAL VIEW posexplode(t.items) pe AS pos, item';
    const position = symbol(sql, 'pos', 'spark', snapshot);
    const field = symbol(sql, 'sku', 'spark', snapshot);
    expect(position?.definitions[0]?.location.selectionStart).toBe(sql.lastIndexOf('pos'));
    expect(position?.type).toMatch(/INT|number/i);
    expect(field?.definitions[0]?.location.source).toBe('file:///t.sql');
  });

  it('publishes catalog signatures and inferred built-in return types', () => {
    const sql = "SELECT split(payload.name, ',') FROM sales.orders";
    const resolved = symbol(sql, 'split', 'spark');
    expect(resolved?.functionCategory).toBe('builtin');
    expect(resolved?.functionCatalogVersion).toBe('4.2.0');
    expect(resolved?.functionSignatures?.[0]).toContain('ARRAY<STRING>');
    expect(resolved?.type).toContain('ARRAY');
  });

  it('keeps all same-level UNION projection definitions', () => {
    const schema = createSchemaSnapshot([
      parseDdlSchema('CREATE TABLE a (id BIGINT); CREATE TABLE b (id BIGINT);', 'spark', 'file:///ab.sql'),
    ]);
    const sql = 'WITH u AS (SELECT id AS x FROM a UNION ALL SELECT id AS x FROM b) SELECT x FROM u';
    const usage = symbol(sql, 'x', 'spark', schema, 2);
    expect(usage?.definitions).toHaveLength(2);
    expect(usage?.definitions.every((definition) => definition.kind === 'projection')).toBe(true);
  });

  it('tracks local DDL offsets across statements and respects DROP', () => {
    const sql = 'CREATE TABLE local_t (id BIGINT);\nSELECT id FROM local_t;\nDROP TABLE local_t;\nSELECT id FROM local_t;';
    const first = symbol(sql, 'id', 'spark', { tables: [], issues: [] }, 1);
    expect(first?.definitions[0]?.location.source).toBe(CURRENT_SQL_DOCUMENT_SOURCE);
    expect(first?.definitions[0]?.location.selectionStart).toBe(sql.indexOf('id'));
    expect(symbol(sql, 'id', 'spark', { tables: [], issues: [] }, 2)).toBeUndefined();
  });

  it('resolves a projection expression before publishing its same-name alias', () => {
    const sql = 'CREATE TABLE test_table (a INT); SELECT a AS a FROM test_table;';
    const ddlColumn = sql.indexOf('a INT');
    const expressionOffset = sql.indexOf('SELECT a') + 'SELECT '.length;
    const aliasOffset = sql.indexOf('AS a') + 'AS '.length;

    const expression = getSqlSymbolAtOffset(sql, expressionOffset, 'spark', [], { tables: [], issues: [] });
    expect(expression?.kind).toBe('column');
    expect(expression?.definitions[0]?.location.source).toBe(CURRENT_SQL_DOCUMENT_SOURCE);
    expect(expression?.definitions[0]?.location.selectionStart).toBe(ddlColumn);

    const alias = getSqlSymbolAtOffset(sql, aliasOffset, 'spark', [], { tables: [], issues: [] });
    expect(alias?.kind).toBe('projection');
    expect(alias?.definitions[0]?.location.selectionStart).toBe(ddlColumn);
  });

  it('resolves columns inside a parenthesized INSERT SELECT', () => {
    const sql = 'CREATE TABLE t1 (a INT); INSERT INTO t1 (SELECT a FROM t1);';
    const usageOffset = sql.indexOf('SELECT a') + 'SELECT '.length;
    const usage = getSqlSymbolAtOffset(sql, usageOffset, 'spark', [], { tables: [], issues: [] });

    expect(usage?.kind).toBe('column');
    expect(usage?.definitions[0]?.location.source).toBe(CURRENT_SQL_DOCUMENT_SOURCE);
    expect(usage?.definitions[0]?.location.selectionStart).toBe(sql.indexOf('a INT'));
  });

  it('maps from_json STRUCT field origins into the schema literal', () => {
    const sql = "SELECT from_json(json_data, 'STRUCT<name: STRING, nested: STRUCT<value: INT>>').nested.value FROM t";
    const snapshot = createSchemaSnapshot([parseDdlSchema(
      'CREATE TABLE t (json_data STRING);',
      'spark',
      'file:///t.sql',
    )]);
    const resolved = symbol(sql, 'value', 'spark', snapshot, 1);
    const target = resolved?.definitions[0]?.location;
    expect(target?.source).toBe('');
    expect(sql.slice(target?.selectionStart, target?.selectionEnd)).toBe('value');
  });

  it('omits unknown symbols and placeholders', () => {
    const sql = 'SELECT ${field}, missing FROM ${table}';
    const placeholders = [/\$\{[^}]+\}/gu];
    expect(getSqlSymbolAtOffset(sql, sql.indexOf('field'), 'spark', placeholders, { tables: [], issues: [] })).toBeUndefined();
    expect(getSqlSymbolAtOffset(sql, sql.indexOf('missing'), 'spark', placeholders, { tables: [], issues: [] })).toBeUndefined();
  });
});
