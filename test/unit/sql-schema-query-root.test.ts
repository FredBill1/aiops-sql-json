import { describe, expect, it } from 'vitest';

import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  getSqlSchemaAtOffset,
  parseDdlSchema,
} from '../../src/sqlSchemaCore';

const EMPTY_SCHEMA = { tables: [], issues: [] } as const;

describe('query-root schema inference', () => {
  it('treats parenthesized SELECT roots as transparent for global CTAS inference', () => {
    const parsed = parseDdlSchema(
      `CREATE TABLE direct_ctas AS SELECT 1 AS a;
CREATE TABLE wrapped_ctas AS (SELECT 1 AS a);
CREATE TABLE nested_ctas AS ((SELECT 1 AS a));`,
      'spark',
      'query-roots.sql',
    );
    const snapshot = createSchemaSnapshot([parsed]);

    expect(snapshot.issues).toEqual([]);
    expect(Object.fromEntries(snapshot.tables.map((table) => [
      table.name,
      table.columns.map((column) => column.name),
    ]))).toEqual({
      direct_ctas: ['a'],
      wrapped_ctas: ['a'],
      nested_ctas: ['a'],
    });
  });

  it('keeps set operations and inline VALUES inferable at query roots', () => {
    const parsed = parseDdlSchema(
      `CREATE TABLE union_ctas AS (SELECT 1 AS a UNION ALL SELECT 2 AS a);
CREATE TABLE values_ctas AS VALUES (1, 'x');
CREATE TABLE wrapped_values_ctas AS (VALUES (2, 'y'));`,
      'spark',
      'query-primary.sql',
    );
    const snapshot = createSchemaSnapshot([parsed]);

    expect(snapshot.issues).toEqual([]);
    expect(snapshot.tables.find((table) => table.name === 'union_ctas')?.columns.map((column) => column.name)).toEqual([
      'a',
    ]);
    expect(snapshot.tables.find((table) => table.name === 'values_ctas')?.columns.map((column) => column.name)).toEqual([
      'col1',
      'col2',
    ]);
    expect(snapshot.tables.find((table) => (
      table.name === 'wrapped_values_ctas'
    ))?.columns.map((column) => column.name)).toEqual(['col1', 'col2']);
  });

  it('makes a parenthesized local CTAS visible to following statements', () => {
    const sql = `CREATE TABLE local_wrapped AS ((SELECT 1 AS a, 'x' AS b));
SELECT a, b FROM local_wrapped;`;

    expect(analyzeSqlSemantics(sql, 'spark', [], EMPTY_SCHEMA, [])).toEqual([]);

    const snapshot = getSqlSchemaAtOffset(sql, sql.lastIndexOf('SELECT'), 'spark', [], EMPTY_SCHEMA);
    const table = snapshot.tables.find((candidate) => candidate.name === 'local_wrapped');
    expect(table?.columns.map((column) => column.name)).toEqual(['a', 'b']);
    expect(table?.columns.map((column) => column.typeFamily)).toEqual(['number', 'string']);
  });

  it('preserves semantic diagnostics inside a parenthesized CTAS query', () => {
    const sql = 'CREATE TABLE source_table (a INT); '
      + 'CREATE TABLE bad_ctas AS (SELECT missing FROM source_table);';
    const issues = analyzeSqlSemantics(sql, 'spark', [], EMPTY_SCHEMA, []);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown-column',
        start: sql.indexOf('missing'),
      }),
    ]));
    expect(issues.some((issue) => issue.code === 'local-table-unresolved')).toBe(false);
  });

  it('classifies standalone parenthesized queries structurally instead of by leading keyword', () => {
    const valid = 'CREATE TABLE source_table (a INT); (SELECT a FROM source_table);';
    expect(analyzeSqlSemantics(valid, 'spark', [], EMPTY_SCHEMA, [])).toEqual([]);

    const invalid = 'CREATE TABLE source_table (a INT); (SELECT missing FROM source_table);';
    expect(analyzeSqlSemantics(invalid, 'spark', [], EMPTY_SCHEMA, [])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown-column',
        start: invalid.indexOf('missing'),
      }),
    ]));
  });

  it('validates standalone VALUES queries through the same query-root path', () => {
    const issues = analyzeSqlSemantics('VALUES (mystery(1));', 'spark', [], EMPTY_SCHEMA, []);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown-function', severity: 'warning' }),
    ]));
  });
});
