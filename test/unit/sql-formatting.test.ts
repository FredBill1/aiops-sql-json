import { describe, expect, it } from 'vitest';

import type { SqlFormatConfiguration } from '../../src/config';
import { compilePlaceholderPatterns } from '../../src/patterns';
import { SQL_DIALECTS } from '../../src/sql';
import { formatSql } from '../../src/sqlFormatting';

const configuration: SqlFormatConfiguration = {
  maxLineWidth: 120,
  maxInlineExpressionDepth: 4,
  caseLayout: 'auto',
  structuralParenthesisPosition: 'sameLine',
  statementListLayout: 'onePerLine',
  sqlJsonBaseIndent: 1,
  keywordCase: 'upper',
  functionCase: 'upper',
  dataTypeCase: 'upper',
  commaPosition: 'trailing',
  logicalOperatorPosition: 'before',
  semicolonPosition: 'sameLine',
  blankLinesBetweenStatements: 1,
};

const editor = { tabSize: 2, insertSpaces: true, eol: '\n' };
const placeholders = compilePlaceholderPatterns(['\\$\\{[^}]+\\}', '\\$\\w+']).patterns;

describe('SQL formatting', () => {
  it('formats clauses and statement lists without changing identifiers or literals', () => {
    const result = formatSql(
      "select userId,sum(amount) as total from sales where dt='2026-01-01' and enabled=true group by userId",
      'spark',
      placeholders,
      configuration,
      editor,
    );

    expect(result.text).toBe([
      'SELECT',
      '  userId,',
      '  SUM(amount) AS total',
      'FROM sales',
      'WHERE',
      "  dt = '2026-01-01' AND enabled = true",
      'GROUP BY',
      '  userId',
    ].join('\n'));
  });

  it('always expands structural parentheses and supports a new-line opening style', () => {
    const result = formatSql(
      'with x as (select a,b from t) select * from x',
      'spark',
      placeholders,
      { ...configuration, structuralParenthesisPosition: 'newLine' },
      editor,
    );

    expect(result.text).toContain('WITH x AS\n(\n  SELECT');
    expect(result.text).toContain('\n)\nSELECT');
  });

  it('keeps CTEs and outer projections as lists without splitting inline function arguments', () => {
    const result = formatSql(
      'with first as(select a from one),second as(select b from two) select pair(a,b),b from second',
      'spark',
      placeholders,
      configuration,
      editor,
    );

    expect(result.text).toContain('),\nsecond AS (');
    expect(result.text).toContain('  PAIR(a, b),\n  b');
  });

  it('keeps configured placeholders byte-for-byte while formatting around them', () => {
    const source = 'select prefix_$column, ${metric}(value) from $table where n > $limit.0';
    const result = formatSql(source, 'spark', placeholders, configuration, editor);

    for (const placeholder of ['${metric}', '$column', '$table', '$limit']) {
      expect(result.text).toContain(placeholder);
    }
    expect(result.text).toContain('PREFIX_${metric}'.replace('PREFIX_', ''));
  });

  it('merges overlapping placeholder patterns without changing adjacent source text', () => {
    const overlapping = compilePlaceholderPatterns([
      '\\$\\{[^}]+\\}',
      '\\$\\{metric\\}',
      '\\$\\w+',
    ]).patterns;
    const source = 'select prefix_${column},${metric}(value) from schema_$tenant.table';
    const result = formatSql(source, 'spark', overlapping, configuration, editor);

    for (const original of ['prefix_${column}', '${metric}(value)', 'schema_$tenant.table']) {
      expect(result.text).toContain(original);
    }
  });

  it('treats a multiline placeholder as one opaque byte-preserved fragment', () => {
    const multiline = compilePlaceholderPatterns(['\\{\\{[\\s\\S]+?\\}\\}']).patterns;
    const placeholder = '{{left\n  right}}';
    const result = formatSql(`select ${placeholder} from source_table`, 'spark', multiline, configuration, editor);

    expect(result.text).toContain(placeholder);
    expect(result.text.match(/\{\{left\n {2}right\}\}/gu)).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = formatSql('select a,b from t where a=1 or b=2', 'spark', placeholders, configuration, editor).text;
    const twice = formatSql(once, 'spark', placeholders, configuration, editor).text;
    expect(twice).toBe(once);
  });

  it('supports fit lists, leading commas, lower-case tokens, and after-position logical operators', () => {
    const result = formatSql(
      'SELECT alpha,beta,gamma FROM items WHERE alpha=1 AND beta=2 AND gamma=3',
      'spark',
      placeholders,
      {
        ...configuration,
        maxLineWidth: 32,
        statementListLayout: 'fit',
        commaPosition: 'leading',
        logicalOperatorPosition: 'after',
        keywordCase: 'lower',
        functionCase: 'lower',
        dataTypeCase: 'lower',
      },
      editor,
    );

    expect(result.text).toContain('select alpha, beta, gamma');
    expect(result.text).toMatch(/alpha = 1 AND\n|alpha = 1 and\n/u);
  });

  it('applies keyword, function, and data-type casing independently', () => {
    const result = formatSql(
      'select coalesce(cast(value as decimal(10,2)),0) as result from source_table',
      'spark',
      placeholders,
      {
        ...configuration,
        keywordCase: 'upper',
        functionCase: 'lower',
        dataTypeCase: 'lower',
      },
      editor,
    );

    expect(result.text).toContain('SELECT');
    expect(result.text).toContain('coalesce(cast(value AS decimal(10, 2)), 0) AS result');
    expect(result.text).toContain('FROM source_table');
  });

  it('supports leading list commas and configurable multi-statement terminators', () => {
    const leading = formatSql(
      'select a,b from source_table',
      'spark',
      placeholders,
      { ...configuration, commaPosition: 'leading' },
      editor,
    ).text;
    const statements = formatSql(
      'select 1;select 2;',
      'spark',
      placeholders,
      { ...configuration, semicolonPosition: 'newLine', blankLinesBetweenStatements: 2 },
      editor,
    ).text;

    expect(leading).toContain('  a\n  , b');
    expect(statements).toContain('\n;\n\n\nSELECT');
    expect(statements.endsWith('\n;')).toBe(true);
  });

  it('expands CREATE TABLE schemas and INSERT target column lists', () => {
    const ddl = formatSql('create table dst(a int,b string)', 'spark', placeholders, configuration, editor).text;
    const insert = formatSql('insert into dst(a,b) select x,y from src', 'spark', placeholders, configuration, editor).text;

    expect(ddl).toBe(['CREATE TABLE dst (', '  a INT,', '  b STRING', ')'].join('\n'));
    expect(insert).toContain('INSERT INTO dst (\n  a,\n  b\n)');
    expect(insert).toContain('\nSELECT\n');
  });

  it('breaks deeply nested function expressions while retaining attached function parentheses', () => {
    const result = formatSql(
      'select outer_fn(mid_fn(inner_fn(last_fn(value)))) from t',
      'spark',
      placeholders,
      { ...configuration, maxInlineExpressionDepth: 2 },
      editor,
    );

    expect(result.text).toContain('OUTER_FN(');
    expect(result.text.split('\n').length).toBeGreaterThan(4);
  });

  it('round-trips CASE, CAST, windows, and comments without rewriting their payloads', () => {
    const source = "select case when a=1 then sum(amount) over(partition by customer order by created_at) else cast(0 as int) end as score -- keep Me\nfrom sales";
    const result = formatSql(source, 'spark', placeholders, { ...configuration, maxLineWidth: 300 }, editor);

    expect(result.text).toContain('CASE WHEN a = 1 THEN SUM(');
    expect(result.text).toContain(') OVER (');
    expect(result.text).toContain('PARTITION BY customer ORDER BY created_at');
    expect(result.text).toContain('ELSE CAST(0 AS INT) END AS score -- keep Me');
    expect(result.lines.some((line) => line.semanticBreakAfter)).toBe(true);
  });

  it('expands a CASE as one structural unit when it exceeds the line-width or depth limit', () => {
    const source = "select case when '1' = '1' then '1' when '2' = '2' then '2' when '3' = '3' then '3' when '4' = '4' then '4' when '5' = '5' then '5' when '6' = '6' then '6' end as x";
    const expected = [
      'SELECT',
      '  CASE',
      "    WHEN '1' = '1' THEN '1'",
      "    WHEN '2' = '2' THEN '2'",
      "    WHEN '3' = '3' THEN '3'",
      "    WHEN '4' = '4' THEN '4'",
      "    WHEN '5' = '5' THEN '5'",
      "    WHEN '6' = '6' THEN '6'",
      '  END AS x',
    ].join('\n');

    expect(formatSql(source, 'spark', placeholders, configuration, editor).text).toBe(expected);
    expect(formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300, maxInlineExpressionDepth: 2 },
      editor,
    ).text).toBe(expected);
  });

  it('keeps short CASE expressions inline in auto mode and expands all CASE expressions on request', () => {
    const source = 'select case value when 1 then case when flag=1 then a else b end else c end as result';
    const inline = formatSql(
      'select case when flag=1 then a else b end as result',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const expanded = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300, caseLayout: 'expanded' },
      editor,
    ).text;

    expect(inline).toContain('  CASE WHEN flag = 1 THEN a ELSE b END AS result');
    expect(expanded).toBe([
      'SELECT',
      '  CASE value',
      '    WHEN 1 THEN CASE',
      '      WHEN flag = 1 THEN a',
      '      ELSE b',
      '    END',
      '    ELSE c',
      '  END AS result',
    ].join('\n'));
  });

  it.each(SQL_DIALECTS)('expands CASE expressions for the %s dialect', (dialect) => {
    const result = formatSql(
      "select case when 1=1 then 'yes' else 'no' end as result",
      dialect,
      placeholders,
      { ...configuration, caseLayout: 'expanded' },
      editor,
    ).text;

    expect(result).toContain("  CASE\n    WHEN 1 = 1 THEN 'yes'\n    ELSE 'no'\n  END AS result");
  });

  it('uses the requested EOL and tabs while allowing only an indivisible token to exceed width', () => {
    const result = formatSql(
      'select thisIdentifierIsLongerThanTwentyColumns from t where a=1 and b=2',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 20 },
      { tabSize: 4, insertSpaces: false, eol: '\r\n' },
    );

    expect(result.text).toContain('\r\n\tthisIdentifierIsLongerThanTwentyColumns');
    expect(result.text).not.toMatch(/(?<!\r)\n/u);
    expect(result.text.split('\r\n').filter((line) => line.length > 20)).toEqual([
      '\tthisIdentifierIsLongerThanTwentyColumns',
    ]);
  });

  it.each([
    ['spark', 'select array(1,2) as values from t'],
    ['hive', 'select nvl(a,0) from t'],
    ['flink', 'select coalesce(a,0) from t'],
    ['mysql', 'select ifnull(a,0) from t'],
    ['postgresql', 'select coalesce(a,0) from t'],
    ['trino', 'select coalesce(a,0) from t'],
    ['impala', 'select nvl(a,0) from t'],
    ['generic', 'select coalesce(a,0) from t'],
  ] as const)('formats the %s dialect', (dialect, source) => {
    const result = formatSql(source, dialect, placeholders, configuration, editor);
    expect(result.text).toContain('SELECT');
    expect(result.text).toContain('FROM t');
  });
});
