import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import { astChild, astChildren, astFunctionName, parseSqlAst } from '../../src/sqlAst';
import { getSqlCatalog } from '../../src/sqlCatalog';
import { createSchemaSnapshot, getSqlSymbolAtOffset } from '../../src/sqlSchemaCore';
import { functionTypeCases } from './sql-schema-function-types.cases';

const baseline = JSON.parse(readFileSync(new URL('../../catalog/function-catalog.coverage.json', import.meta.url), 'utf8')) as Record<SqlDialect, {
  maximumFallback: number; minimumReviewed: number; minimumGenerated: number; previousFallback: number;
}>;

describe('runtime function contract coverage', () => {
  it.each(SQL_DIALECTS)('%s does not regress to name-based guesses', (dialect) => {
    const definitions = getSqlCatalog(dialect).functionDefinitions;
    const count = (source: string) => definitions.filter((definition) => definition.signatureSource === source).length;
    expect(count('fallback')).toBeLessThanOrEqual(baseline[dialect].maximumFallback);
    expect(count('fallback')).toBeLessThan(baseline[dialect].previousFallback);
    expect(count('explicit')).toBeGreaterThanOrEqual(baseline[dialect].minimumReviewed);
    expect(count('generated')).toBeGreaterThanOrEqual(baseline[dialect].minimumGenerated);
    for (const definition of definitions.filter((definition) => definition.signatureSource === 'generated')) {
      expect(definition.argumentValidation).toBe('partial');
      expect(definition.documentation?.sources.length).toBeGreaterThan(0);
    }
  });

  it('models every discovered function producer with a reviewed or documented contract', () => {
    for (const testCase of functionTypeCases) {
      const sql = `SELECT ${testCase.expression} FROM typed_values`;
      const statement = parseSqlAst(sql, testCase.dialect)?.statements[0];
      let expression = statement && astChildren(statement, 'expressions')[0];
      while (expression && ['window', 'ignoreNulls', 'respectNulls'].includes(expression.kind)) {
        expression = astChild(expression, 'this');
      }
      if (!expression || (!expression.call && !['function', 'unnest'].includes(expression.role))) continue;
      const name = astFunctionName(expression, sql).toLowerCase();
      const definition = getSqlCatalog(testCase.dialect).functionByName.get(name);
      expect(definition, `${testCase.dialect}: ${name}`).toBeDefined();
      expect(definition?.signatureSource, `${testCase.dialect}: ${name}`).not.toBe('fallback');
    }
  });

  it.each([
    ['spark', 'ARRAY_CONTAINS', 'array_contains(array(1), 1)', 'boolean'],
    ['hive', 'BASE64', "base64(CAST('x' AS BINARY))", 'string'],
    ['flink', 'IS_ALPHA', "is_alpha('abc')", 'boolean'],
    ['mysql', 'FLOOR', 'floor(1.2)', 'number'],
    ['postgresql', 'ACOS', 'acos(0.5)', 'number'],
    ['trino', 'ACOS', 'acos(0.5)', 'number'],
    ['impala', 'BASE64ENCODE', "base64encode('x')", 'string'],
  ] as const)('%s evaluates generated %s metadata', (dialect, name, expression, family) => {
    expect(getSqlCatalog(dialect).functionByName.get(name.toLowerCase())?.signatureSource).toBe('generated');
    const sql = `SELECT ${expression} AS result`;
    expect(getSqlSymbolAtOffset(sql, sql.indexOf('result'), dialect, [], createSchemaSnapshot([]))?.dataType)
      .toMatchObject({ kind: 'scalar', family });
  });
});
