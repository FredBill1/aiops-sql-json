import { describe, expect, it } from 'vitest';

import { SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import { getSqlCatalog } from '../../src/sqlCatalog';
import { astFunctionName, parseSqlAst, walkSqlAst, type SqlAstNode } from '../../src/sqlAst';

const expectedParser: Record<SqlDialect, string> = {
  spark: 'spark',
  hive: 'hive',
  flink: 'flink',
  mysql: 'mysql',
  postgresql: 'postgres',
  trino: 'trino',
  impala: 'hive',
  generic: 'trino',
};

describe('normalized SQL AST frontend', () => {
  it.each(SQL_DIALECTS)('preserves identifiers, CTEs, JOINs, wildcards, and UTF-16 spans for %s', (dialect) => {
    const sql = `WITH recent AS (SELECT id FROM orders)
SELECT recent.id, ghost.*
FROM recent JOIN orders o USING (id)`;
    const ast = parseSqlAst(sql, dialect);
    expect(ast?.parserDialect).toBe(expectedParser[dialect]);
    expect(ast?.statements[0]?.role).toBe('select');
    expect(findNodes(ast?.statements[0], (node) => node.role === 'cte').map((node) => node.alias)).toEqual(['recent']);
    expect(findNodes(ast?.statements[0], (node) => node.role === 'join')).toHaveLength(1);
    const ghost = findNodes(ast?.statements[0], (node) => node.role === 'column' && node.name === '*')[0];
    expect(ghost && sql.slice(ghost.start, ghost.end)).toBe('ghost.*');
  });

  it.each(SQL_DIALECTS)('normalizes DDL and INSERT target columns for %s', (dialect) => {
    const ast = parseSqlAst(
      'CREATE TABLE objects (id BIGINT, label VARCHAR(20)); INSERT INTO objects (id, label) SELECT id, label FROM source;',
      dialect,
    );
    expect(ast?.statements.map((statement) => statement.role)).toEqual(['create', 'insert']);
    expect(findNodes(ast?.statements[0], (node) => node.kind === 'columnDef').map((node) => node.name)).toEqual([
      'id',
      'label',
    ]);
    expect(findNodes(ast?.statements[1], (node) => node.role === 'schema')[0]?.aliasColumns).toEqual([]);
  });

  it('normalizes DELETE and MERGE as statement roles', () => {
    const ast = parseSqlAst(
      'DELETE FROM target WHERE id = 1; '
        + 'MERGE INTO target t USING source s ON t.id = s.id WHEN MATCHED THEN DELETE;',
      'spark',
    );
    expect(ast?.statements.map((statement) => statement.role)).toEqual(['delete', 'merge']);
  });

  it.each([
    ['spark', 'SELECT tag FROM batches b LATERAL VIEW EXPLODE(b.tags) e AS tag', 'anonymous'],
    ['hive', 'SELECT tag FROM batches b LATERAL VIEW EXPLODE(b.tags) e AS tag', 'anonymous'],
    ['flink', 'SELECT tag FROM batches b CROSS JOIN UNNEST(b.tags) AS e(tag)', 'unnest'],
    ['mysql', `SELECT e.tag FROM batches b JOIN JSON_TABLE(b.payload, '$[*]' COLUMNS(tag VARCHAR(20) PATH '$')) e ON TRUE`, 'jsonTable'],
    ['postgresql', 'SELECT e.tag FROM batches b CROSS JOIN LATERAL jsonb_array_elements_text(b.payload) e(tag)', 'anonymous'],
    ['trino', 'SELECT tag FROM batches b CROSS JOIN UNNEST(b.tags) AS e(tag)', 'unnest'],
    ['impala', 'SELECT tag.item FROM batches b, b.tags tag', 'table'],
    ['generic', 'SELECT tag FROM batches b CROSS JOIN UNNEST(b.tags) AS e(tag)', 'unnest'],
  ] as const)('normalizes the %s expansion relation', (dialect, sql, expectedKind) => {
    const root = parseSqlAst(sql, dialect)?.statements[0];
    expect(findNodes(root, (node) => node.kind === expectedKind).length).toBeGreaterThan(0);
  });

  it('recovers source names and exact spans for parser-specialized catalog functions', () => {
    const mismatches: string[] = [];
    for (const dialect of SQL_DIALECTS.filter((candidate) => candidate !== 'generic')) {
      for (const catalogName of getSqlCatalog(dialect).functions) {
        if (dialect === 'postgresql' && catalogName === 'XMLTABLE') continue;
        let checked = false;
        for (const arity of [2, 1, 3, 0, 4]) {
          if (checked) break;
          const args = Array.from({ length: arity }, (_unused, index) => String(index + 1)).join(', ');
          const sql = `SELECT ${catalogName}(${args})`;
          const root = parseSqlAst(sql, dialect)?.statements[0];
          const functions = findNodes(root, (node) => node.source !== undefined);
          const source = functions[0];
          if (!source) continue;
          checked = true;
          const actual = astFunctionName(source, sql).split('.').at(-1)?.toLocaleUpperCase();
          const span = sql.slice(source.nameStart, source.nameEnd).replace(/\s+/gu, '').toLocaleUpperCase();
          if (actual !== catalogName.toLocaleUpperCase() || span !== catalogName.toLocaleUpperCase()) {
            mismatches.push(`${dialect}.${catalogName}:${source.kind}->${actual ?? ''}@${span}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 30_000);

  it('recovers XMLTABLE from its PostgreSQL-specific syntax', () => {
    const sql = `SELECT * FROM XMLTABLE('/ROWS/ROW' PASSING doc COLUMNS id INT PATH 'ID') AS x`;
    const root = parseSqlAst(sql, 'postgresql')?.statements[0];
    const node = findNodes(root, (candidate) => candidate.kind === 'xmlTable')[0];
    expect(node && astFunctionName(node, sql).toLocaleUpperCase()).toBe('XMLTABLE');
    expect(node && sql.slice(node.nameStart, node.nameEnd).toLocaleUpperCase()).toBe('XMLTABLE');
  });

  it('preserves exact names beside a generated megabyte string literal', () => {
    const payload = 'Ab09'.repeat(250_000);
    const sql = `SELECT decode(unbase64('${payload}'), 'UTF-8')`;
    const root = parseSqlAst(sql, 'spark')?.statements[0];
    expect(root).toBeDefined();
    const decode = findNodes(root, (node) => node.kind === 'decode')[0]!;
    const unbase64 = findNodes(root, (node) => node.kind === 'fromBase64')[0]!;
    expect(decode.source).toMatchObject({ name: 'decode', start: 7, end: 13 });
    expect(unbase64.source).toMatchObject({ name: 'unbase64', start: 14, end: 22 });
    const literal = findNodes(root, (node) => node.role === 'literal' && node.name === payload)[0]!;
    expect(sql.slice(literal.start, literal.end)).toBe(`'${payload}'`);
  });

  it.each([
    ['spark', "SELECT CAST(x AS STRING), SUBSTRING(x FROM 2 FOR 3), CURRENT_DATE", ['CAST', 'SUBSTRING', 'CURRENT_DATE']],
    ['postgresql', "SELECT EXTRACT(YEAR FROM x), DATE_PART('YEAR', x), CURRENT_TIMESTAMP", ['EXTRACT', 'DATE_PART', 'CURRENT_TIMESTAMP']],
    ['mysql', "SELECT * FROM JSON_TABLE(x, '$[*]' COLUMNS (id INT PATH '$')) t", ['JSON_TABLE']],
    ['trino', 'SELECT * FROM UNNEST(x) t(id)', ['UNNEST']],
    ['flink', "SELECT MAP['a', 1], ARRAY[1, 2]", ['MAP', 'ARRAY']],
  ] as const)('records source names directly for %s grammar', (dialect, sql, expected) => {
    const nodes = findNodes(parseSqlAst(sql, dialect)?.statements[0], (node) => node.source !== undefined);
    expect(nodes.map((node) => astFunctionName(node, sql))).toEqual(expected);
    for (const node of nodes) expect(sql.slice(node.nameStart, node.nameEnd)).toBe(node.source!.name);
  });

  it('keeps provenance and original argument slots through parser copies', () => {
    const sql = 'SELECT f(a).g(false).h(NULL)';
    const nodes = findNodes(parseSqlAst(sql, 'spark')?.statements[0], (node) => node.source !== undefined);
    expect(nodes.map((node) => node.source!.name)).toEqual(['f', 'g', 'h']);
    expect(nodes.map((node) => node.call?.arguments.map((arg) => sql.slice(arg.start, arg.end))))
      .toEqual([['a'], ['false'], ['NULL']]);
    expect(new Set(nodes.map((node) => node.source!.id)).size).toBe(3);
  });

  it('preserves quoted name ranges and UTF-16 offsets without scanning source text', () => {
    const sql = '-- 😀\r\nSELECT db.`myFunc`(a), `myFunc`(b)';
    const nodes = findNodes(parseSqlAst(sql, 'spark')?.statements[0], (node) => node.source !== undefined);
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(astFunctionName(node, sql)).toBe('myFunc');
      expect(sql.slice(node.nameStart, node.nameEnd)).toBe('`myFunc`');
    }
    expect(nodes[0]?.nameStart).toBe(sql.indexOf('`myFunc`'));
  });

  it('distinguishes synthetic functions from physical SQL names', () => {
    const sql = "SELECT datediff(a, b), unix_timestamp(), DATE '2020-01-01', CASE WHEN a THEN b END";
    const synthetic = findNodes(parseSqlAst(sql, 'spark')?.statements[0], (node) => node.role === 'function' && !node.source);
    expect(synthetic.map((node) => node.kind)).toEqual(expect.arrayContaining(['tsOrDsToDate', 'currentTimestamp', 'cast', 'if']));
    for (const node of synthetic) expect(node.nameEnd).toBe(node.nameStart);
  });
});

function findNodes(
  root: SqlAstNode | undefined,
  predicate: (node: SqlAstNode) => boolean,
): SqlAstNode[] {
  if (!root) return [];
  const result: SqlAstNode[] = [];
  walkSqlAst(root, (node) => {
    if (predicate(node)) result.push(node);
  });
  return result;
}
