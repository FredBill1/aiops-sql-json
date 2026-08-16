import { describe, expect, it } from 'vitest';

import { compilePlaceholderPatterns } from '../../src/patterns';
import { analyzeSql, lineColumnToOffset, SQL_DIALECTS } from '../../src/sql';

describe('SQL analysis', () => {
  it.each(SQL_DIALECTS)('validates valid and invalid %s SQL', (dialect) => {
    expect(analyzeSql('SELECT 1;', dialect, []).issues).toEqual([]);
    expect(analyzeSql('SELEC 1;', dialect, []).issues.length).toBeGreaterThan(0);
  });

  it('classifies common SQL tokens', () => {
    const analysis = analyzeSql("SELECT sum(price), 42, 'x' FROM sales -- note", 'spark', []);
    expect(analysis.tokens.some((token) => token.type === 'keyword')).toBe(true);
    expect(analysis.tokens.some((token) => token.type === 'function')).toBe(true);
    expect(analysis.tokens.some((token) => token.type === 'number')).toBe(true);
    expect(analysis.tokens.some((token) => token.type === 'string')).toBe(true);
    expect(analysis.tokens.some((token) => token.type === 'comment')).toBe(true);
  });

  it('supports configurable placeholder masking', () => {
    const placeholders = compilePlaceholderPatterns(['\\$\\{[^}]+\\}']).patterns;
    const strict = analyzeSql('SELECT * FROM ${table};', 'spark', []);
    const templated = analyzeSql('SELECT * FROM ${table};', 'spark', placeholders);
    expect(strict.issues.length).toBeGreaterThan(0);
    expect(templated.issues).toEqual([]);
  });

  it('accepts a numeric placeholder followed by a decimal fraction', () => {
    const placeholders = compilePlaceholderPatterns(['\\$\\w+']).patterns;
    expect(analyzeSql('SELECT data FROM mytable WHERE value > $limit.0', 'spark', placeholders).issues).toEqual([]);
  });

  it('reports high-confidence structural errors missed by the Spark grammar', () => {
    const issues = analyzeSql('select data from where and', 'spark', []).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.message.includes('relation after FROM'))).toBe(true);
  });

  it.each(SQL_DIALECTS)('reports incomplete CASE expressions once for %s SQL', (dialect) => {
    for (const sql of ['select case', 'select case when']) {
      const issues = analyzeSql(sql, dialect, []).issues;
      expect(issues, sql).toHaveLength(1);
    }
  });

  it.each(SQL_DIALECTS)('accepts searched, simple, and nested CASE expressions for %s SQL', (dialect) => {
    const statements = [
      'SELECT CASE WHEN 1 = 1 THEN 1 ELSE 0 END;',
      'SELECT CASE value WHEN 1 THEN 1 ELSE 0 END FROM source_table;',
      'SELECT CASE WHEN 1 = 1 THEN CASE WHEN 2 = 2 THEN 2 END ELSE 0 END;',
    ];
    for (const sql of statements) {
      expect(analyzeSql(sql, dialect, []).issues, sql).toEqual([]);
    }
  });

  it('does not confuse valid boolean and quoted-identifier syntax with structural gaps', () => {
    const sql = 'SELECT * FROM `where` WHERE value BETWEEN 1 AND 2 AND enabled = true';
    expect(analyzeSql(sql, 'spark', []).issues).toEqual([]);
  });

  it('converts one-based SQL positions into UTF-16 offsets', () => {
    expect(lineColumnToOffset('a\r\nbc\nd', 2, 2)).toBe(4);
    expect(lineColumnToOffset('a\r\nbc\nd', 3, 1)).toBe(6);
  });
});
