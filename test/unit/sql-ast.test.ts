import { describe, expect, it } from 'vitest';

import { SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import { getSqlCatalog } from '../../src/sqlCatalog';
import { astFunctionName, parseSqlAst, walkSqlAst, type SqlAstNode } from '../../src/sqlAst';

const expectedParser: Record<SqlDialect, string> = {
  spark: 'spark',
  hive: 'hive',
  flink: 'trino',
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
          const functions = findNodes(root, (node) => node.role === 'function');
          const source = functions[0];
          if (!source) continue;
          checked = true;
          if (source.ownStart !== undefined) continue;
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
