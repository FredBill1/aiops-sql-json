import { describe, expect, it } from 'vitest';

import { analyzeSql, type SqlDialect } from '../../src/sql';
import { parseSqlAst, walkSqlAst, type SqlAstNode } from '../../src/sqlAst';
import { analyzeSqlSemantics, getSqlSymbolAtOffset } from '../../src/sqlSchemaCore';

interface PercentileFalsePositiveCase {
  readonly name: string;
  readonly dialect: SqlDialect;
  readonly ddl: string;
  readonly expression: string;
}

const sparkNumericDdl = 'CREATE TABLE test_table (x DOUBLE);';
const sparkIntervalDdl = 'CREATE TABLE test_table (x INTERVAL YEAR TO MONTH);';
const hiveDdl = 'CREATE TABLE test_table (whole BIGINT, x DOUBLE);';

// Regression suite for dialect parsers that read the aggregate input separately
// from the remaining source arguments.
//
// Spark: https://spark.apache.org/docs/latest/api/sql/agg-functions/
// Hive: https://hive.apache.org/docs/latest/language/languagemanual-udf/
const cases: readonly PercentileFalsePositiveCase[] = [
  {
    name: 'original scalar PERCENTILE_APPROX report',
    dialect: 'spark',
    ddl: sparkNumericDdl,
    expression: 'percentile_approx(x, 0.1)',
  },
  ...([
    ['PERCENTILE_APPROX with an array percentage', 'percentile_approx(x, array(0.1, 0.5))'],
    ['APPROX_PERCENTILE with a scalar percentage', 'approx_percentile(x, 0.1)'],
    ['APPROX_PERCENTILE with an array percentage', 'approx_percentile(x, array(0.1, 0.5))'],
    ['PERCENTILE with a scalar percentage', 'percentile(x, 0.1)'],
    ['PERCENTILE with an array percentage', 'percentile(x, array(0.1, 0.5))'],
  ] as const).map(([name, expression]) => ({ name, dialect: 'spark' as const, ddl: sparkNumericDdl, expression })),
  ...([
    ['PERCENTILE_APPROX over an interval with a scalar percentage', 'percentile_approx(x, 0.1)'],
    ['PERCENTILE_APPROX over an interval with an array percentage', 'percentile_approx(x, array(0.1, 0.5))'],
    ['APPROX_PERCENTILE over an interval with a scalar percentage', 'approx_percentile(x, 0.1)'],
    ['APPROX_PERCENTILE over an interval with an array percentage', 'approx_percentile(x, array(0.1, 0.5))'],
    ['PERCENTILE over an interval with a scalar percentage', 'percentile(x, 0.1)'],
    ['PERCENTILE over an interval with an array percentage', 'percentile(x, array(0.1, 0.5))'],
  ] as const).map(([name, expression]) => ({ name, dialect: 'spark' as const, ddl: sparkIntervalDdl, expression })),
  ...([
    ['filtered PERCENTILE_APPROX', 'percentile_approx(x, 0.1) FILTER (WHERE x IS NOT NULL)'],
    ['filtered APPROX_PERCENTILE', 'approx_percentile(x, 0.1) FILTER (WHERE x IS NOT NULL)'],
    ['filtered PERCENTILE', 'percentile(x, 0.1) FILTER (WHERE x IS NOT NULL)'],
  ] as const).map(([name, expression]) => ({ name, dialect: 'spark' as const, ddl: sparkNumericDdl, expression })),
  ...([
    ['PERCENTILE with a scalar percentage', 'percentile(whole, 0.1)'],
    ['PERCENTILE with an array percentage', 'percentile(whole, array(0.1, 0.5))'],
    ['PERCENTILE_APPROX with a scalar percentage', 'percentile_approx(x, 0.1)'],
    ['PERCENTILE_APPROX with an array percentage', 'percentile_approx(x, array(0.1, 0.5))'],
    ['PERCENTILE_APPROX with array percentages and explicit accuracy',
      'percentile_approx(x, array(0.1, 0.5), 10000)'],
  ] as const).map(([name, expression]) => ({ name, dialect: 'hive' as const, ddl: hiveDdl, expression })),
];

describe('percentile parser rewrites preserve every source argument', () => {
  it.each(cases)('$dialect: $name', ({ dialect, ddl, expression }) => {
    const sql = `${ddl}\nSELECT ${expression} AS pct FROM test_table;`;
    expect(analyzeSql(sql, dialect, []).issues, sql).toEqual([]);
    expect(analyzeSqlSemantics(sql, dialect, [], { tables: [], issues: [] }, []).map((issue) => ({
      code: issue.code,
      message: issue.message,
    })), sql).toEqual([]);
  });

  it.each([
    ['percentile_approx', '0.1', /INTERVAL/i],
    ['percentile_approx', 'array(0.1, 0.5)', /ARRAY<.*INTERVAL/i],
    ['approx_percentile', '0.1', /INTERVAL/i],
    ['approx_percentile', 'array(0.1, 0.5)', /ARRAY<.*INTERVAL/i],
    ['percentile', '0.1', /INTERVAL/i],
    ['percentile', 'array(0.1, 0.5)', /ARRAY<.*INTERVAL/i],
  ] as const)('Spark %s keeps its first argument type with explicit accuracy', (name, percentage, expected) => {
    const sql = `SELECT ${name}(INTERVAL '1' MONTH, ${percentage}, 10000) AS pct;`;
    expect(analyzeSql(sql, 'spark', []).issues, sql).toEqual([]);
    expect(analyzeSqlSemantics(sql, 'spark', [], { tables: [], issues: [] }, []), sql).toEqual([]);
    const symbol = getSqlSymbolAtOffset(
      sql,
      sql.lastIndexOf('pct'),
      'spark',
      [],
      { tables: [], issues: [] },
    );
    expect(symbol?.type, sql).toMatch(expected);
  });

  it.each(['percentile_approx', 'approx_percentile', 'percentile'])(
    'Spark %s still validates its first argument with explicit accuracy', (name) => {
      const sql = `${sparkNumericDdl}\nSELECT ${name}(missing, 0.1, 10000) FROM test_table;`;
      expect(analyzeSql(sql, 'spark', []).issues, sql).toEqual([]);
      expect(analyzeSqlSemantics(sql, 'spark', [], { tables: [], issues: [] }, []).map((issue) => issue.code), sql)
        .toEqual(['unknown-column']);
    },
  );

  it('retains complete source arguments for ordinary, nested and null-treatment calls', () => {
    const sql = `SELECT
  sort_array(ints, false),
  sha2(encode(s, 'UTF-8'), 256),
  first_value(s, true) OVER (ORDER BY n)
FROM typed_values`;
    const ast = parseSqlAst(sql, 'spark');
    expect(ast).toBeDefined();
    const calls = new Map<string, SqlAstNode['call']>();
    for (const statement of ast?.statements ?? []) {
      walkSqlAst(statement, (node) => {
        if (node.call) calls.set(node.call.name.toLocaleLowerCase(), node.call);
      });
    }
    expect(calls.get('sort_array')?.arguments).toHaveLength(2);
    expect(calls.get('sha2')?.arguments).toHaveLength(2);
    expect(calls.get('encode')?.arguments).toHaveLength(2);
    expect(calls.get('first_value')?.arguments).toHaveLength(2);
  });
});
