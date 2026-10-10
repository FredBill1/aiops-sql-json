import { afterEach, describe, expect, it, vi } from 'vitest';

import { compilePlaceholderPatterns } from '../../src/patterns';
import { SQL_DIALECTS } from '../../src/sqlDialect';
import { classifySqlTokens, lexSql, readSqlLexerTokens, tokenizeSql } from '../../src/sqlLexing';
import { getSqlParser } from '../../src/sqlParserFactory';

afterEach(() => vi.restoreAllMocks());

describe('SQL lexical analysis', () => {
  it.each(SQL_DIALECTS)('never parses or validates %s SQL for highlighting or lexing', (dialect) => {
    const parser = getSqlParser(dialect);
    const parse = vi.spyOn(parser, 'parse').mockImplementation(() => { throw new Error('Must not parse'); });
    const validate = vi.spyOn(parser, 'validate').mockImplementation(() => { throw new Error('Must not validate'); });
    const allTokens = vi.spyOn(parser, 'getAllTokens').mockImplementation(() => { throw new Error('Must not parse for tokens'); });
    const sql = "SELECT custom_function /* keep */ (value), 'literal', 42 FROM";

    expect(tokenizeSql(sql, dialect).some((token) => token.type === 'function')).toBe(true);
    expect(lexSql(sql, dialect).map((token) => token.text).join('')).toBe(sql);
    expect(parse).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(allTokens).not.toHaveBeenCalled();
  });

  it.each(SQL_DIALECTS)('keeps UTF-16 ranges and original bare CR spelling for %s', (dialect) => {
    const sql = "SELECT '😀' AS a /* 𠮷 */\r-- 😀\rSELECT custom_function('𠮷😀'), 42";
    const lexical = lexSql(sql, dialect);
    expect(lexical.map((token) => token.text).join('')).toBe(sql);
    for (const token of lexical) expect(sql.slice(token.start, token.end)).toBe(token.text);
    const highlighted = tokenizeSql(sql, dialect);
    expect(highlighted.filter((token) => token.type === 'string').map((token) => sql.slice(token.start, token.end)))
      .toEqual(["'😀'", "'𠮷😀'"]);
    expect(highlighted.find((token) => token.type === 'function'))
      .toMatchObject({ start: sql.indexOf('custom_function'), end: sql.indexOf('custom_function') + 15 });
    expect(highlighted.find((token) => token.type === 'number'))
      .toMatchObject({ start: sql.lastIndexOf('42'), end: sql.length });
  });

  it('retains source offsets when placeholders containing astral text are masked', () => {
    const sql = "SELECT '${😀}', custom_function(${😀}), 42";
    const placeholders = compilePlaceholderPatterns(['\\$\\{[^}]+\\}']).patterns;
    const tokens = tokenizeSql(sql, 'spark', placeholders);
    expect(tokens.find((token) => token.type === 'function')?.start).toBe(sql.indexOf('custom_function'));
    expect(tokens.find((token) => token.type === 'number')?.start).toBe(sql.lastIndexOf('42'));
    expect(lexSql(sql, 'spark', placeholders).map((token) => token.text).join('')).toBe(sql);
  });

  it('highlights a generated megabyte literal without invoking the grammar', () => {
    const sql = `SELECT decode('${'A'.repeat(1_000_000)}', 'base64') AS payload`;
    const parser = getSqlParser('spark');
    const validate = vi.spyOn(parser, 'validate').mockImplementation(() => { throw new Error('Must not validate'); });
    const tokens = tokenizeSql(sql, 'spark');
    const literal = tokens.find((token) => token.type === 'string');
    expect(literal).toMatchObject({ start: sql.indexOf("'"), end: sql.indexOf("'") + 1_000_002 });
    expect(tokens.some((token) => token.type === 'function')).toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  it('classifies many identifiers in one pass without allocating token tails', () => {
    const sql = `SELECT ${Array.from({ length: 10_000 }, (_value, index) => `column_${index}`).join(', ')}`;
    const tokens = readSqlLexerTokens(sql, 'spark');
    const guarded = new Proxy(tokens, {
      get(target, key, receiver) {
        if (key === 'slice' || key === 'find') throw new Error('Per-token tail scan');
        return Reflect.get(target, key, receiver);
      },
    });
    expect(classifySqlTokens(guarded).filter((token) => token.type === 'variable')).toHaveLength(10_000);
  });
});
