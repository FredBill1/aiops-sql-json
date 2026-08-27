import { afterEach, describe, expect, it, vi } from 'vitest';
import * as catalogs from '../../src/sqlCatalog';
import { astChildren, astFunctionName, parseSqlAst, walkSqlAst, type SqlAstNode } from '../../src/sqlAst';
import {
  analyzeSqlSemantics, createSchemaSnapshot, formatSqlDataType, getSqlSymbolAtOffset, parseDdlSchema,
} from '../../src/sqlSchemaCore';

function functions(sql: string, dialect: 'spark' | 'hive' | 'flink' = 'spark'): SqlAstNode[] {
  const nodes: SqlAstNode[] = [];
  const ast = parseSqlAst(sql, dialect);
  expect(ast).toBeDefined();
  for (const statement of ast!.statements) walkSqlAst(statement, (node) => {
    if (node.role === 'function' || node.call) nodes.push(node);
  });
  return nodes;
}

describe('source call arguments', () => {
  it.each(['false', 'true', 'NULL'])('retains repeated %s arguments in their original slots', (value) => {
    const sql = `SELECT array_replace(items, /* first */ ${value}, ${value}) FROM t`;
    const call = functions(sql).find((node) => node.call?.name === 'array_replace')!.call!;
    expect(call.arguments).toHaveLength(3);
    expect(call.arguments.slice(1).map((node) => sql.slice(node.start, node.end).toUpperCase())).toEqual([value.toUpperCase(), value.toUpperCase()]);
    expect(call.arguments[1]).not.toBe(call.arguments[2]);
  });

  it('separates supplied arguments from synthesized defaults', () => {
    const call = functions("SELECT regexp_extract_all(s, '(.)') FROM t").find((node) => node.kind === 'regexpExtractAll')!;
    expect(call.call?.arguments).toHaveLength(2);
    expect(call.args.group).toMatchObject({ kind: 'literal', name: '1' });
  });

  it.each([
    ['spark', 'array<string>', 'ARRAY<STRING>'],
    ['hive', 'string', 'STRING'],
    ['postgresql', 'int[]', 'ARRAY<INT>'],
    ['postgresql', 'timestamp with time zone', 'TIMESTAMPTZ'],
    ['mysql', 'signed', 'BIGINT'],
    ['spark', 'long', 'BIGINT'],
  ] as const)('retains source type names without losing compound type structure in %s', (dialect, target, expected) => {
    const sql = `SELECT cast(NULL AS ${target}) AS result`;
    const symbol = getSqlSymbolAtOffset(sql, sql.indexOf('result'), dialect, [], createSchemaSnapshot([]));
    expect(symbol?.dataType).toBeDefined();
    expect(formatSqlDataType(symbol!.dataType!).toUpperCase()).toBe(expected);
  });

  it('preserves MAP pair order independently of rewritten key/value arrays', () => {
    const call = functions("SELECT map('a', false, 'b', NULL)").find((node) => node.call?.name.toLowerCase() === 'map')!;
    expect(call.call?.arguments.map((node) => node.kind)).toEqual(['literal', 'boolean', 'literal', 'null']);
  });

  it.each(['spark', 'hive'] as const)('%s retains window/null-treatment arguments without relaxing arity', (dialect) => {
    for (const option of ['true', 'false']) {
      const sql = `SELECT first_value(s, ${option}) OVER (ORDER BY n) FROM t`;
      const call = functions(sql, dialect).find((node) => node.call?.name === 'first_value')!;
      expect(call.call?.arguments).toHaveLength(2);
      expect(astFunctionName(call, sql)).toBe('first_value');
    }
    expect(parseSqlAst('SELECT first_value(s, false, false) OVER (ORDER BY n) FROM t', dialect)).toBeUndefined();
  });

  it('distinguishes Flink MAP constructors from quoted or qualified columns', () => {
    expect(functions("SELECT MAP['a', false]", 'flink').some((node) => node.name === 'MAP')).toBe(true);
    for (const sql of ['SELECT t.MAP[1] FROM t', 'SELECT `MAP`[1] FROM t']) {
      const root = parseSqlAst(sql, 'flink')?.statements[0];
      expect(astChildren(root!, 'expressions')[0]?.kind).toBe('bracket');
    }
    expect(parseSqlAst("SELECT MAP['a', false, 'b']", 'flink')).toBeUndefined();
  });
});

describe('inferred types versus diagnostic evidence', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const original = catalogs.getSqlCatalog('spark');
    const definition = {
      name: 'CATALOG_INCOMPLETE', aliases: [], kind: 'scalar' as const, signatureSource: 'fallback' as const,
      signatures: [{ parameters: [{ type: 'ANY' as const }], returns: { kind: 'argument' as const, index: 0 } }],
    };
    vi.spyOn(catalogs, 'getSqlCatalog').mockReturnValue({
      ...original, functions: [...original.functions, definition.name],
      functionDefinitions: [...original.functionDefinitions, definition],
      functionByName: new Map([...original.functionByName, ['catalog_incomplete', definition]]),
    });
    return createSchemaSnapshot([parseDdlSchema(
      'CREATE TABLE input_values (s STRING, n INT, items ARRAY<INT>); CREATE TABLE destination (value STRING);',
      'spark', 'file:///confidence.sql',
    )]);
  }

  it('still exposes useful inferred types', () => {
    const schema = setup();
    const sql = 'SELECT catalog_incomplete(n) AS result FROM input_values';
    expect(getSqlSymbolAtOffset(sql, sql.indexOf('result'), 'spark', [], schema)?.dataType)
      .toMatchObject({ kind: 'scalar', family: 'number' });
  });

  it.each([
    'SELECT upper(catalog_incomplete(n)) FROM input_values',
    'SELECT transform(catalog_incomplete(items), x -> upper(x)) FROM input_values',
    'SELECT transform(array(catalog_incomplete(n)), x -> upper(x)) FROM input_values',
    'SELECT transform(array(n, catalog_incomplete(n)), x -> upper(x)) FROM input_values',
    'SELECT transform(coalesce(items, array(catalog_incomplete(n))), x -> upper(x)) FROM input_values',
    'SELECT upper(coalesce(n, catalog_incomplete(n))) FROM input_values',
    'SELECT upper(concat(catalog_incomplete(items), catalog_incomplete(items))) FROM input_values',
    'SELECT transform(concat(items, array(catalog_incomplete(n))), x -> upper(x)) FROM input_values',
    'SELECT upper(value) FROM input_values LATERAL VIEW explode(catalog_incomplete(items)) e AS value',
    "SELECT upper(value) FROM input_values LATERAL VIEW inline(catalog_incomplete(array(named_struct('value', n)))) e AS value",
    'SELECT upper(element_at(catalog_incomplete(items), 1)) FROM input_values',
    "SELECT upper(catalog_incomplete(named_struct('value', n)).value) FROM input_values",
    "SELECT catalog_incomplete(named_struct('value', n)).unmodeled_field FROM input_values",
    'WITH q AS (SELECT catalog_incomplete(n) AS value FROM input_values) SELECT upper(value) FROM q',
    "WITH q AS (SELECT catalog_incomplete(named_struct('value', n)) AS value FROM input_values) SELECT upper(q.value.value) FROM q",
    "WITH q AS (SELECT catalog_incomplete(named_struct('value', n)) AS value FROM input_values) SELECT q.value.unmodeled_field FROM q",
    'SELECT zip_with(items, catalog_incomplete(items), (x, y) -> upper(y)) FROM input_values',
    "SELECT transform_values(catalog_incomplete(map('key', n)), (k, v) -> upper(v)) FROM input_values",
    'SELECT upper(value) FROM (SELECT catalog_incomplete(n) AS value FROM input_values) q',
    'CREATE TEMPORARY VIEW q AS SELECT catalog_incomplete(n) AS value FROM input_values; SELECT upper(value) FROM q',
    'CREATE TABLE q AS SELECT catalog_incomplete(n) AS value FROM input_values; SELECT upper(value) FROM q',
    'CREATE TABLE q AS SELECT catalog_incomplete(items) AS value FROM input_values; SELECT upper(value) FROM q',
    'CREATE VIEW q AS SELECT catalog_incomplete(items) AS value FROM input_values; SELECT upper(value) FROM q',
    'INSERT INTO destination SELECT catalog_incomplete(items) FROM input_values',
    'SELECT catalog_incomplete(items) AS value FROM input_values UNION ALL SELECT s FROM input_values',
  ])('does not turn an uncertain inference into an error: %s', (sql) => {
    expect(analyzeSqlSemantics(sql, 'spark', [], setup(), [])).toEqual([]);
  });

  it.each([
    'SELECT upper(array(catalog_incomplete(n))) FROM input_values',
    'SELECT upper(coalesce(items, array(catalog_incomplete(n)))) FROM input_values',
    'SELECT transform(s, x -> x) FROM input_values',
    'SELECT sort_array(false) FROM input_values',
    "SELECT sort_array(items, 'not-boolean') FROM input_values",
    "SELECT sha2(s, 'not-a-number') FROM input_values",
    'SELECT upper(missing_column) FROM input_values',
    'INSERT INTO destination SELECT items FROM input_values',
    'SELECT items FROM input_values UNION ALL SELECT s FROM input_values',
  ])('retains errors supported by known types: %s', (sql) => {
    expect(analyzeSqlSemantics(sql, 'spark', [], setup(), []).length).toBeGreaterThan(0);
  });

  it('still checks arity for complete dialect contracts', () => {
    expect(analyzeSqlSemantics('SELECT array_sort(ARRAY[1], true, true, false)', 'postgresql', [], createSchemaSnapshot([]), [])
      .map((issue) => issue.code)).toContain('function-argument-count');
  });
});
