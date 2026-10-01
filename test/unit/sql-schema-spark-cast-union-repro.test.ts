import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { analyzeSql } from '../../src/sql';
import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  getSqlScopeInfo,
  getSqlSymbolAtOffset,
  parseDdlSchema,
} from '../../src/sqlSchemaCore';

const fixtures = new URL('../fixtures/spark-cast-union-repro/', import.meta.url);
const readFixture = (name: string) => readFileSync(new URL(name, fixtures), 'utf8');
const schema = createSchemaSnapshot([
  parseDdlSchema(readFixture('schema/tables.sql'), 'spark', 'file:///schema/tables.sql'),
]);
const baseline = readFixture('baseline.sql');
const ansiUnion = readFixture('ansi-union.sql');
const starExcept = readFixture('star-except.sql');
const issues = (sql: string) => analyzeSqlSemantics(sql, 'spark', [], schema, []);

function expectTwoCastDefinitions(sql: string, offset: number): void {
  const symbol = getSqlSymbolAtOffset(sql, offset, 'spark', [], schema);
  expect(symbol?.type).toBe('DOUBLE');
  expect(symbol?.definitions).toHaveLength(2);
  const cast = 'CAST(raw_value AS DOUBLE)';
  const firstCast = sql.indexOf(cast);
  const secondCast = sql.indexOf(cast, firstCast + 1);
  expect(symbol?.definitions.map((definition) => {
    expect(definition.kind).toBe('projection');
    expect(sql.slice(definition.location.selectionStart, definition.location.selectionEnd)).toBe('value');
    return sql.lastIndexOf(cast, definition.location.selectionStart);
  })).toEqual([firstCast, secondCast]);
}

describe('reproductions of Spark CAST / CTE / UNION schema false positives', () => {
  it('accepts all reproduction files as Spark syntax and indexes the external DDL', () => {
    expect(schema.issues).toEqual([]);
    for (const sql of [baseline, ansiUnion, starExcept]) {
      expect(analyzeSql(sql, 'spark', []).issues).toEqual([]);
    }
  });

  it('accepts the two direct casts and preserves both definitions', () => {
    expect(issues(baseline)).toEqual([]);
    expectTwoCastDefinitions(baseline, baseline.lastIndexOf('SELECT value') + 'SELECT '.length);
  });

  it('reproduces the ANSI UNION mismatch despite a DOUBLE reference with two cast definitions', () => {
    expect(issues(ansiUnion)).toEqual([
      expect.objectContaining({
        code: 'incompatible-type',
        message: 'Cannot assign string value to value (DOUBLE).',
      }),
    ]);
    expectTwoCastDefinitions(ansiUnion, ansiUnion.lastIndexOf('SELECT value') + 'SELECT '.length);
    expect(issues(ansiUnion.replace("SELECT '0' AS value", 'SELECT 0.0 AS value'))).toEqual([]);
  });

  it('reproduces the excluded STRING column leaking into wildcard INSERT output', () => {
    expect(issues(starExcept)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'insert-column-count',
        message: 'INSERT writes 2 value(s) into 1 target column(s).',
      }),
      expect.objectContaining({
        code: 'incompatible-type',
        message: 'Cannot assign string value to value (DOUBLE).',
      }),
    ]));
    const offset = starExcept.lastIndexOf('WHERE value') + 'WHERE '.length;
    expectTwoCastDefinitions(starExcept, offset);
    const scope = getSqlScopeInfo(starExcept, offset, 'spark', [], schema);
    expect(scope.relations[0]?.columns.map((column) => [column.name, column.typeFamily])).toEqual([
      ['raw_value', 'string'], ['value', 'number'],
    ]);
    expect(issues(starExcept.replace('SELECT * FROM cast_values', 'SELECT value FROM cast_values'))).toEqual([]);
  });

  // Known false positives: the desired behavior is zero diagnostics. Keep these
  // expected failures visible while this task intentionally leaves the checker unfixed.
  it.fails('accepts ANSI UNION of DOUBLE casts with a numeric STRING default', () => {
    expect(issues(ansiUnion)).toEqual([]);
  });

  it.fails('accepts wildcard EXCEPT followed by DOUBLE casts through a UNION CTE', () => {
    expect(issues(starExcept)).toEqual([]);
  });
});
