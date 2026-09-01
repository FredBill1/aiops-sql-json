import { describe, expect, it } from 'vitest';

import { analyzeSql, lexSql, SQL_DIALECTS } from '../../src/sql';
import {
  isSqlAstNode,
  parseSqlAst,
  type SqlAstNode,
  type SqlAstValue,
} from '../../src/sqlAst';
import { maskSqlParserGaps, type ParserGapDialect } from '../../src/sqlParserGaps';

function collectAstNodes(value: SqlAstValue): SqlAstNode[] {
  if (Array.isArray(value)) return value.flatMap(collectAstNodes);
  if (!isSqlAstNode(value)) return [];
  return [value, ...Object.values(value.args).flatMap(collectAstNodes)];
}

describe('SQL parser-gap normalization', () => {
  it.each(SQL_DIALECTS)('retains genuine duplicate query and JOIN clauses for %s', (dialect) => {
    const invalidSql = [
      'SELECT 1 FROM source_table ORDER BY 1 ORDER BY 1',
      'SELECT 1 FROM source_table LIMIT 1 LIMIT 2',
      'SELECT * FROM source_table JOIN other_table ON TRUE ON FALSE',
    ];
    for (const sql of invalidSql) {
      expect(analyzeSql(sql, dialect, []).issues.length, sql).toBeGreaterThan(0);
    }
  });

  it.each([
    ['mysql', "SELECT JSON_VALUE('{}', '$' DEFAULT ON EMPTY)"],
    ['flink', "SELECT JSON_QUERY('{}', '$' EMPTY ARRAY ON)"],
    ['postgresql', "SELECT JSON_VALUE(JSONB '{}', '$' ERROR ON ERROR NULL ON EMPTY)"],
    ['mysql', "SELECT * FROM JSON_TABLE('[1]', '$[*]' COLUMNS(v INT PATH '$' DEFAULT ON EMPTY)) AS jt"],
    ['trino', "SELECT JSON_VALUE('{}', '$' RETURNING DEFAULT 0 ON EMPTY)"],
    ['mysql', 'SELECT JSON_ARRAY(NULL NULL ON NULL)'],
    ['spark', "SELECT JSON_VALUE('{}', '$' DEFAULT 0 ON EMPTY)"],
  ] as const)('does not hide malformed %s SQL/JSON modifiers', (dialect, sql) => {
    const normalized = maskSqlParserGaps(sql, dialect);
    expect(normalized).toHaveLength(sql.length);
    expect(analyzeSql(sql, dialect, []).issues.length, sql).toBeGreaterThan(0);
  });

  it.each([
    ['mysql', "SELECT JSON_VALUE('{}', '$' DEFAULT 0 ON ERROR DEFAULT 0 ON EMPTY)"],
    ['postgresql', "SELECT JSON_VALUE(JSONB '{}', '$' NULL ON ERROR NULL ON EMPTY)"],
    ['trino', "SELECT JSON_QUERY('{}', '$' EMPTY ARRAY ON ERROR EMPTY ARRAY ON EMPTY)"],
  ] as const)('leaves out-of-order %s handlers visible to the parser', (dialect, sql) => {
    const normalized = maskSqlParserGaps(sql, dialect);
    expect(normalized).toContain('ON ERROR');
    expect(normalized).toContain('ON EMPTY');
    expect(analyzeSql(sql, dialect, []).issues.length, sql).toBeGreaterThan(0);
  });

  it('preserves source ranges while the validator and fallback AST use normalized text', () => {
    const sql = `SELECT JSON_VALUE(
  JSONB '{"value":"雪"}', '$.value'
  RETURNING INTEGER
  DEFAULT 0 ON EMPTY
  DEFAULT 0 ON ERROR
) AS result`;
    const normalized = maskSqlParserGaps(sql, 'postgresql');

    expect(normalized).toHaveLength(sql.length);
    expect([...normalized.matchAll(/\n/gu)].map((match) => match.index))
      .toEqual([...sql.matchAll(/\n/gu)].map((match) => match.index));
    for (const fragment of ['JSON_VALUE', `'{"value":"雪"}'`, "'$.value'", ') AS result']) {
      expect(normalized.indexOf(fragment), fragment).toBe(sql.indexOf(fragment));
    }
    for (const fragment of ['JSONB', 'RETURNING INTEGER', 'DEFAULT 0 ON EMPTY', 'DEFAULT 0 ON ERROR']) {
      const start = sql.indexOf(fragment);
      expect(normalized.slice(start, start + fragment.length).trim(), fragment).toBe('');
    }

    const sourceTokens = lexSql(sql, 'postgresql');
    expect(sourceTokens.find((token) => token.text.toLocaleUpperCase() === 'RETURNING')?.start)
      .toBe(sql.indexOf('RETURNING'));
    expect(sourceTokens.find((token) => token.text === 'result')?.start).toBe(sql.indexOf('result'));

    const ast = parseSqlAst(sql, 'postgresql');
    expect(ast).toBeDefined();
    const nodes = ast?.statements.flatMap(collectAstNodes) ?? [];
    const jsonValue = nodes.find((node) => node.role === 'function'
      && node.name.toLocaleUpperCase() === 'JSON_VALUE');
    expect(jsonValue?.nameStart).toBe(sql.indexOf('JSON_VALUE'));
    expect(jsonValue?.call?.arguments).toHaveLength(2);
    expect(jsonValue?.call?.arguments[0]?.start).toBe(sql.indexOf(`'{"value":"雪"}'`));
    expect(jsonValue?.call?.arguments[1]?.start).toBe(sql.indexOf("'$.value'"));
  });

  it.each([
    'JSON_VALUE',
    'JSON_QUERY',
    'JSON_ARRAY',
    'JSON_OBJECT',
    'JSON_ARRAYAGG',
    'JSON_OBJECTAGG',
  ])('keeps non-SQL/JSON calls named %s untouched', (name) => {
    const sql = `SELECT namespace.${name}(value) FROM source_table`;
    expect(maskSqlParserGaps(sql, 'generic' satisfies ParserGapDialect)).toBe(sql);
  });

  it('does not normalize schema-qualified functions that only resemble SQL/JSON syntax', () => {
    const sql = "SELECT custom.JSON_VALUE('{}', '$' RETURNING INTEGER DEFAULT 0 ON EMPTY)";
    expect(maskSqlParserGaps(sql, 'postgresql')).toBe(sql);
  });
});
