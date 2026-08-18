import { describe, expect, it } from 'vitest';

import type { SqlFormatConfiguration } from '../../src/config';
import { compilePlaceholderPatterns } from '../../src/patterns';
import { SQL_DIALECTS } from '../../src/sql';
import { formatSql } from '../../src/sqlFormatting';

const configuration: SqlFormatConfiguration = {
  maxLineWidth: 120,
  maxInlineExpressionDepth: 4,
  maxInlineItems: 4,
  layoutMode: 'compact',
  structuralParenthesisPosition: 'sameLine',
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
      'SELECT userId, SUM(amount) AS total',
      'FROM sales',
      "WHERE dt = '2026-01-01' AND enabled = true",
      'GROUP BY userId',
    ].join('\n'));
  });

  it('keeps four SELECT items inline and fully expands five items', () => {
    const four = formatSql(
      "select '1','2','3','4'",
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    const five = formatSql(
      "select '1','2','3','4','5'",
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    const leading = formatSql(
      "select '1','2','3','4','5'",
      'spark',
      placeholders,
      { ...configuration, commaPosition: 'leading' },
      editor,
    ).text;
    const configuredFive = formatSql(
      "select '1','2','3','4','5'",
      'spark',
      placeholders,
      { ...configuration, maxInlineItems: 5 },
      editor,
    ).text;

    expect(four).toBe("SELECT '1', '2', '3', '4'");
    expect(five).toBe([
      'SELECT',
      "  '1',",
      "  '2',",
      "  '3',",
      "  '4',",
      "  '5'",
    ].join('\n'));
    expect(leading).toBe([
      'SELECT',
      "  '1'",
      "  , '2'",
      "  , '3'",
      "  , '4'",
      "  , '5'",
    ].join('\n'));
    expect(configuredFive).toBe("SELECT '1', '2', '3', '4', '5'");
  });

  it('applies the item limit to high-level comma lists', () => {
    const from = formatSql(
      'select * from first_source,second_source,third_source,fourth_source,fifth_source',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const values = formatSql(
      'insert into target_table values (1),(2),(3),(4),(5)',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const update = formatSql(
      'update target_table set a=1,b=2,c=3,d=4,e=5 where id=1',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(from).toContain([
      'FROM',
      '  first_source,',
      '  second_source,',
      '  third_source,',
      '  fourth_source,',
      '  fifth_source',
    ].join('\n'));
    expect(values).toContain([
      'VALUES',
      '  (1),',
      '  (2),',
      '  (3),',
      '  (4),',
      '  (5)',
    ].join('\n'));
    expect(update).toContain([
      'SET',
      '  a = 1,',
      '  b = 2,',
      '  c = 3,',
      '  d = 4,',
      '  e = 5',
    ].join('\n'));
    for (const [dialect, formatted] of [
      ['spark', from],
      ['spark', values],
      ['spark', update],
    ] as const) {
      expect(formatSql(formatted, dialect, placeholders, { ...configuration, maxLineWidth: 300 }, editor).text)
        .toBe(formatted);
    }
  });

  it('applies the item limit to WITH and BY lists', () => {
    const withClause = formatSql(
      'with a as (select 1),b as (select 2),c as (select 3),d as (select 4),e as (select 5) select * from e',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const byClauses = formatSql(
      'select a from t group by a,b,c,d,e order by a,b,c,d,e',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(withClause).toContain('),\nb AS (');
    expect(withClause).toContain('),\ne AS (');
    expect(byClauses).toContain('GROUP BY\n  a,\n  b,\n  c,\n  d,\n  e');
    expect(byClauses).toContain('ORDER BY\n  a,\n  b,\n  c,\n  d,\n  e');
  });

  it.each([
    ['CLUSTER BY', 'select a from t cluster by a,b,c,d,e'],
    ['DISTRIBUTE BY', 'select a from t distribute by a,b,c,d,e'],
    ['SORT BY', 'select a from t sort by a,b,c,d,e'],
  ] as const)('applies the item limit to %s lists', (clause, source) => {
    const result = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(result).toContain(`${clause}\n  a,\n  b,\n  c,\n  d,\n  e`);
  });

  it('applies the item limit to RETURNING and WINDOW lists', () => {
    const returning = formatSql(
      'update target_table set value=1 returning a,b,c,d,e',
      'postgresql',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const window = formatSql(
      'select sum(value) over w1 from source_table window w1 as (),w2 as (),w3 as (),w4 as (),w5 as ()',
      'postgresql',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(returning).toContain('RETURNING\n  a,\n  b,\n  c,\n  d,\n  e');
    expect(window).toContain('WINDOW\n  w1 AS (),\n  w2 AS (),\n  w3 AS (),\n  w4 AS (),\n  w5 AS ()');
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

  it('keeps query-wrapper layout independent from the nested SELECT item count', () => {
    const fourSource = 'select a,b,c,d from (select 1 as a,2 as b,3 as c,4 as d) base';
    const fiveSource = 'select a,b,c,d from (select 1 as a,2 as b,3 as c,4 as d,5 as e) base';
    const four = formatSql(fourSource, 'spark', placeholders, configuration, editor).text;
    const five = formatSql(fiveSource, 'spark', placeholders, configuration, editor).text;

    expect(four).toBe([
      'SELECT a, b, c, d',
      'FROM (',
      '  SELECT 1 AS a, 2 AS b, 3 AS c, 4 AS d',
      ') base',
    ].join('\n'));
    expect(five).toBe([
      'SELECT a, b, c, d',
      'FROM (',
      '  SELECT',
      '    1 AS a,',
      '    2 AS b,',
      '    3 AS c,',
      '    4 AS d,',
      '    5 AS e',
      ') base',
    ].join('\n'));
    expect(formatSql(four, 'spark', placeholders, configuration, editor).text).toBe(four);
    expect(formatSql(five, 'spark', placeholders, configuration, editor).text).toBe(five);
  });

  it.each([
    ['trailing', [
      'SELECT *',
      'FROM (',
      '  SELECT 1 AS a',
      ') first,',
      '  (',
      '    SELECT 2 AS b',
      '  ) second',
    ]],
    ['leading', [
      'SELECT *',
      'FROM (',
      '  SELECT 1 AS a',
      ') first',
      '  , (',
      '    SELECT 2 AS b',
      '  ) second',
    ]],
  ] as const)('restores layout state between sibling query wrappers with %s commas', (commaPosition, lines) => {
    const result = formatSql(
      'select * from (select 1 as a) first,(select 2 as b) second',
      'spark',
      placeholders,
      { ...configuration, commaPosition },
      editor,
    ).text;

    expect(result).toBe(lines.join('\n'));
    expect(formatSql(
      result,
      'spark',
      placeholders,
      { ...configuration, commaPosition },
      editor,
    ).text).toBe(result);
  });

  it.each(['compact', 'expanded'] as const)(
    'honors structuralParenthesisPosition independently in %s mode',
    (layoutMode) => {
      const source = 'select a,b,c,d from (select 1 as a,2 as b,3 as c,4 as d) base';
      const sameLine = formatSql(
        source,
        'spark',
        placeholders,
        { ...configuration, layoutMode, structuralParenthesisPosition: 'sameLine' },
        editor,
      ).text;
      const newLine = formatSql(
        source,
        'spark',
        placeholders,
        { ...configuration, layoutMode, structuralParenthesisPosition: 'newLine' },
        editor,
      ).text;

      expect(sameLine).toContain('FROM (\n');
      expect(sameLine).not.toContain('FROM\n(');
      expect(newLine).toContain('FROM\n(\n');
    },
  );

  it('applies independent list layout to CTE, scalar, EXISTS, and nested query wrappers', () => {
    const cte = formatSql(
      'with x as (select a,b,c,d from t) select * from x',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    const scalar = formatSql(
      'select (select a,b,c,d from t) as nested_value from base',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    const exists = formatSql(
      'select value from t where exists (select a,b,c,d from source_table)',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    const nested = formatSql(
      'select * from (select a,b,c,d from (select 1 as a,2 as b,3 as c,4 as d) inner_base) outer_base',
      'spark',
      placeholders,
      { ...configuration, maxInlineExpressionDepth: 20 },
      editor,
    ).text;
    const valuesCte = formatSql(
      'with x as (values (1,2,3,4)) select * from x',
      'postgresql',
      placeholders,
      configuration,
      editor,
    ).text;
    const ctas = formatSql(
      'create table target_table as (select 1 as a,2 as b,3 as c,4 as d)',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;

    expect(cte).toContain('WITH x AS (\n  SELECT a, b, c, d');
    expect(scalar).toContain('SELECT (\n  SELECT a, b, c, d');
    expect(exists).toContain('EXISTS (\n  SELECT a, b, c, d');
    expect(nested.match(/FROM \(/gu)).toHaveLength(2);
    expect(nested).toContain('SELECT a, b, c, d');
    expect(nested).toContain('SELECT 1 AS a, 2 AS b, 3 AS c, 4 AS d');
    expect(valuesCte).toContain('WITH x AS (\n  VALUES (1, 2, 3, 4)');
    expect(ctas).toContain('AS (\n  SELECT 1 AS a, 2 AS b, 3 AS c, 4 AS d');
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
    expect(result.text).toContain('SELECT PAIR(a, b), b');
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
        layoutMode: 'compact',
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

  it('breaks a long AND chain only at complete predicate boundaries', () => {
    const source = "select '1' where '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1';";
    const result = formatSql(source, 'spark', placeholders, configuration, editor).text;

    expect(result).toBe([
      "SELECT '1'",
      'WHERE',
      "  '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1'",
      "  AND '1' = '1';",
    ].join('\n'));
    expect(result).not.toMatch(/'1'\n\s*=|=\s*\n\s*'1'/u);
  });

  it('falls back to complete WHERE predicate planning when AST logical coverage is partial', () => {
    const cases = [
      [
        'select 1 where 1 in (1, 2) and cast(3 as int) > 0 and cast(3 as int) > 0 and cast(3 as int) > 0 and cast(3 as int) > 0;',
        [
          'SELECT 1',
          'WHERE',
          '  1 IN (1, 2)',
          '  AND CAST(3 AS INT) > 0',
          '  AND CAST(3 AS INT) > 0',
          '  AND CAST(3 AS INT) > 0',
          '  AND CAST(3 AS INT) > 0;',
        ],
      ],
      [
        'select 1 where 1 in (1, 2) and 1 in (1, 2) and cast(3 as int) > 0 and cast(3 as int) > 0 and cast(3 as int) > 0 and cast(3 as int) > 0;',
        [
          'SELECT 1',
          'WHERE',
          '  1 IN (1, 2)',
          '  AND 1 IN (1, 2)',
          '  AND CAST(3 AS INT) > 0',
          '  AND CAST(3 AS INT) > 0',
          '  AND CAST(3 AS INT) > 0',
          '  AND CAST(3 AS INT) > 0;',
        ],
      ],
      [
        'select 1 where 1 in (1, 2) and 1 in (1, 2) and 3 > 0 and 3 > 0 and 3 > 0 and 3 > 0;',
        [
          'SELECT 1',
          'WHERE',
          '  1 IN (1, 2)',
          '  AND 1 IN (1, 2)',
          '  AND 3 > 0',
          '  AND 3 > 0',
          '  AND 3 > 0',
          '  AND 3 > 0;',
        ],
      ],
    ] as const;

    for (const [source, expectedLines] of cases) {
      const itemLimited = formatSql(
        source,
        'spark',
        placeholders,
        { ...configuration, maxLineWidth: 300 },
        editor,
      ).text;
      expect(itemLimited).toBe(expectedLines.join('\n'));
      expect(formatSql(
        itemLimited,
        'spark',
        placeholders,
        { ...configuration, maxLineWidth: 300 },
        editor,
      ).text).toBe(itemLimited);
    }

    const widthLimited = formatSql(
      cases[1][0],
      'spark',
      placeholders,
      { ...configuration, maxInlineItems: 100, maxLineWidth: 120 },
      editor,
    ).text;
    expect(widthLimited).toBe(cases[1][1].join('\n'));
  });

  it('breaks mixed logical expressions by precedence in compact mode', () => {
    const source = "select '1' where '1' = '1' and '1' = '1' or '1' = '1' and '1' = '1' and '1' = '1' and '1' = '1' or '1' = '1' or '1' = '1' and '1' = '1' and '1' = '1';";
    const result = formatSql(source, 'spark', placeholders, configuration, editor).text;

    expect(result).toBe([
      "SELECT '1'",
      'WHERE',
      "  '1' = '1' AND '1' = '1'",
      "  OR '1' = '1' AND '1' = '1' AND '1' = '1' AND '1' = '1'",
      "  OR '1' = '1'",
      "  OR '1' = '1' AND '1' = '1' AND '1' = '1';",
    ].join('\n'));
  });

  it('uses total logical leaf count and expands mixed predicates one level at a time', () => {
    const source = 'select value from t where a=1 and b=2 or c=3 and d=4 or e=5';
    const result = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(result).toBe([
      'SELECT value',
      'FROM t',
      'WHERE',
      '  a = 1 AND b = 2',
      '  OR c = 3 AND d = 4',
      '  OR e = 5',
    ].join('\n'));
  });

  it.each(SQL_DIALECTS)('counts parenthesized logical subtrees toward maxInlineItems for %s', (dialect) => {
    const source = 'select 1 where 1=1 and (1=1 or 1=1 and 1=1 and 1=1) and 1=1;';
    const formatConfiguration = { ...configuration, maxLineWidth: 300 };
    const result = formatSql(source, dialect, placeholders, formatConfiguration, editor).text;

    expect(result).toBe([
      'SELECT 1',
      'WHERE',
      '  1 = 1',
      '  AND (1 = 1 OR 1 = 1 AND 1 = 1 AND 1 = 1)',
      '  AND 1 = 1;',
    ].join('\n'));
    expect(formatSql(result, dialect, placeholders, formatConfiguration, editor).text).toBe(result);
  });

  it('recursively reapplies maxInlineItems inside parenthesized logical subtrees', () => {
    const source = 'select 1 where a=1 and (b=2 or c=3 and d=4 and e=5 and f=6) and g=7;';
    const formatConfiguration = { ...configuration, maxLineWidth: 300 };
    const result = formatSql(source, 'spark', placeholders, formatConfiguration, editor).text;

    expect(result).toBe([
      'SELECT 1',
      'WHERE',
      '  a = 1',
      '  AND (',
      '    b = 2',
      '    OR c = 3 AND d = 4 AND e = 5 AND f = 6',
      '  )',
      '  AND g = 7;',
    ].join('\n'));
    expect(formatSql(result, 'spark', placeholders, formatConfiguration, editor).text).toBe(result);
  });

  it('keeps semantic expression containers opaque to the high-level logical item limit', () => {
    const source = 'select value from t where predicate_fn(a=1 and b=2 and c=3 and d=4 and e=5)';
    const result = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(result).toBe([
      'SELECT value',
      'FROM t',
      'WHERE PREDICATE_FN(a = 1 AND b = 2 AND c = 3 AND d = 4 AND e = 5)',
    ].join('\n'));
  });

  it('counts BETWEEN as one predicate and honors logical operator placement', () => {
    const four = formatSql(
      'select value from t where score BETWEEN 1 and 2 and a=1 and b=2 and c=3',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const five = formatSql(
      'select value from t where score BETWEEN 1 and 2 and a=1 and b=2 and c=3 and d=4',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300, logicalOperatorPosition: 'after' },
      editor,
    ).text;

    expect(four).toContain('WHERE score BETWEEN 1 AND 2 AND a = 1 AND b = 2 AND c = 3');
    expect(five).toContain([
      'WHERE',
      '  score BETWEEN 1 AND 2 AND',
      '  a = 1 AND',
      '  b = 2 AND',
      '  c = 3 AND',
      '  d = 4',
    ].join('\n'));
  });

  it('expands a parenthesized high-level predicate at semantic boundaries', () => {
    const result = formatSql(
      'select value from t where (a=1 or b=2 or c=3 or d=4 or e=5)',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(result).toContain([
      'WHERE',
      '  (',
      '    a = 1',
      '    OR b = 2',
      '    OR c = 3',
      '    OR d = 4',
      '    OR e = 5',
      '  )',
    ].join('\n'));
  });

  it.each([
    ['HAVING', 'select key from t group by key having a=1 and b=2 and c=3 and d=4 and e=5'],
    ['QUALIFY', 'select key from t qualify a=1 and b=2 and c=3 and d=4 and e=5'],
  ] as const)('applies the logical item limit to %s', (clause, source) => {
    const result = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(result).toContain(`${clause}\n  a = 1\n  AND b = 2\n  AND c = 3\n  AND d = 4\n  AND e = 5`);
  });

  it('applies the logical item limit to JOIN ON predicates', () => {
    const result = formatSql(
      'select t.id from t join u on a=1 and b=2 and c=3 and d=4 and e=5',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(result).toContain([
      'JOIN u',
      '  ON',
      '    a = 1',
      '    AND b = 2',
      '    AND c = 3',
      '    AND d = 4',
      '    AND e = 5',
    ].join('\n'));
  });

  it('expands high-level structures without forcing short local argument lists', () => {
    const source = 'select coalesce(a,b),c from t where a=1 and b=2 or c=3';
    const result = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, layoutMode: 'expanded' },
      editor,
    ).text;

    expect(result).toBe([
      'SELECT',
      '  COALESCE(a, b),',
      '  c',
      'FROM',
      '  t',
      'WHERE',
      '  a = 1',
      '  AND b = 2',
      '  OR c = 3',
    ].join('\n'));
  });

  it('does not treat the AND inside BETWEEN as a logical-chain boundary', () => {
    const result = formatSql(
      'select value from t where score BETWEEN 1 and 2',
      'spark',
      placeholders,
      { ...configuration, layoutMode: 'expanded' },
      editor,
    ).text;

    expect(result).toContain('  score BETWEEN 1 AND 2');
    expect(result).not.toContain('1\n  AND 2');
  });

  it('keeps fitting parenthesized logical groups intact when their parent expands', () => {
    const source = 'select value from t where (alpha=1 or beta=2) and (gamma=3 or delta=4)';
    const result = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 48 },
      editor,
    ).text;

    expect(result).toContain([
      'WHERE',
      '  (alpha = 1 OR beta = 2)',
      '  AND (gamma = 3 OR delta = 4)',
    ].join('\n'));
  });

  it('allows an unsplittable semantic predicate to exceed width instead of breaking at equals', () => {
    const result = formatSql(
      'select value from t where very_long_identifier=another_very_long_identifier',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 20 },
      editor,
    ).text;

    expect(result).toContain('  very_long_identifier = another_very_long_identifier');
    expect(result).not.toMatch(/identifier\n\s*=|=\s*\n/u);
  });

  it('places Spark CREATE TABLE suffix clauses on separate lines', () => {
    const source = "create table IF not exists spark_formatter_test (id bigint COMMENT 'unique id', name string COMMENT 'user name', event_date date COMMENT 'event date') using PARQUET options('compression' = 'snappy') PARTITIONED by (event_date) CLUSTERED by (id) SORTED by (id desc) into 8 BUCKETS LOCATION '/tmp/spark_formatter_test' COMMENT 'Spark SQL formatter test table';";
    const result = formatSql(source, 'spark', placeholders, configuration, editor).text;

    expect(result).toBe([
      'CREATE TABLE IF NOT EXISTS spark_formatter_test (',
      "  id BIGINT COMMENT 'unique id', name STRING COMMENT 'user name', event_date DATE COMMENT 'event date'",
      ')',
      'USING PARQUET',
      "OPTIONS ('compression' = 'snappy')",
      'PARTITIONED BY (event_date)',
      'CLUSTERED BY (id)',
      'SORTED BY (id DESC)',
      'INTO 8 BUCKETS',
      "LOCATION '/tmp/spark_formatter_test'",
      "COMMENT 'Spark SQL formatter test table';",
    ].join('\n'));

    const expanded = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, layoutMode: 'expanded' },
      editor,
    ).text;
    expect(expanded).toContain([
      'CREATE TABLE IF NOT EXISTS spark_formatter_test (',
      "  id BIGINT COMMENT 'unique id',",
      "  name STRING COMMENT 'user name',",
      "  event_date DATE COMMENT 'event date'",
      ')',
    ].join('\n'));
    expect(expanded).toContain("\nOPTIONS ('compression' = 'snappy')\n");
  });

  it('expands only an overlong DDL option list and keeps table comments distinct from column comments', () => {
    const source = "create table options_test (id bigint comment 'column') using parquet options('compression'='snappy','mergeSchema'='true') comment 'table';";
    const result = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 44 },
      editor,
    ).text;

    expect(result).toContain("  id BIGINT COMMENT 'column'");
    expect(result).toContain([
      'OPTIONS (',
      "  'compression' = 'snappy',",
      "  'mergeSchema' = 'true'",
      ')',
      "COMMENT 'table';",
    ].join('\n'));
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

  it('keeps function parentheses local in unwrapped CREATE TABLE AS SELECT', () => {
    const source = [
      'create table tmp_table as',
      'select abs(1) as a',
    ].join('\n');

    const formatted = formatSql(
      source,
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;

    expect(formatted).toBe([
      'CREATE TABLE tmp_table AS',
      'SELECT ABS(1) AS a',
    ].join('\n'));
    expect(formatted).not.toContain('ABS (');

    expect(formatSql(
      formatted,
      'spark',
      placeholders,
      configuration,
      editor,
    ).text).toBe(formatted);
  });

  it('supports leading list commas and configurable multi-statement terminators', () => {
    const leading = formatSql(
      'select a,b from source_table',
      'spark',
      placeholders,
      { ...configuration, layoutMode: 'expanded', commaPosition: 'leading' },
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

  it('uses the item limit for CREATE TABLE schemas and INSERT target column lists', () => {
    const ddl = formatSql('create table dst(a int,b string)', 'spark', placeholders, configuration, editor).text;
    const insert = formatSql('insert into dst(a,b) select x,y from src', 'spark', placeholders, configuration, editor).text;
    const ddlFive = formatSql(
      'create table dst(a int,b string,c int,d int,e int)',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    const insertFive = formatSql(
      'insert into dst(a,b,c,d,e) select a,b,c,d,e from src',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;

    expect(ddl).toBe(['CREATE TABLE dst (', '  a INT, b STRING', ')'].join('\n'));
    expect(insert).toContain('INSERT INTO dst (\n  a, b\n)');
    expect(ddlFive).toBe([
      'CREATE TABLE dst (',
      '  a INT,',
      '  b STRING,',
      '  c INT,',
      '  d INT,',
      '  e INT',
      ')',
    ].join('\n'));
    expect(insertFive).toContain('INSERT INTO dst (\n  a,\n  b,\n  c,\n  d,\n  e\n)');
    expect(insert).toContain('\nSELECT x, y\n');
  });

  it('keeps structural-list parenthesis placement independent from list expansion', () => {
    const source = 'create table dst(a int,b string,c int,d int)';
    const newLine = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, structuralParenthesisPosition: 'newLine' },
      editor,
    ).text;
    const expanded = formatSql(
      source,
      'spark',
      placeholders,
      { ...configuration, layoutMode: 'expanded' },
      editor,
    ).text;
    const expandedNewLine = formatSql(
      source,
      'spark',
      placeholders,
      {
        ...configuration,
        layoutMode: 'expanded',
        structuralParenthesisPosition: 'newLine',
      },
      editor,
    ).text;

    expect(newLine).toBe([
      'CREATE TABLE dst',
      '(',
      '  a INT, b STRING, c INT, d INT',
      ')',
    ].join('\n'));
    expect(expanded).toBe([
      'CREATE TABLE dst (',
      '  a INT,',
      '  b STRING,',
      '  c INT,',
      '  d INT',
      ')',
    ].join('\n'));
    expect(expandedNewLine).toBe([
      'CREATE TABLE dst',
      '(',
      '  a INT,',
      '  b STRING,',
      '  c INT,',
      '  d INT',
      ')',
    ].join('\n'));
  });

  it('supports width-triggered and leading-comma structural-list expansion', () => {
    const width = formatSql(
      'create table dst(first_long_column int,second_long_column int)',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 36 },
      editor,
    ).text;
    const leading = formatSql(
      'insert into dst(a,b,c,d,e) select a,b,c,d,e from src',
      'spark',
      placeholders,
      { ...configuration, commaPosition: 'leading' },
      editor,
    ).text;

    expect(width).toContain('  first_long_column INT,\n  second_long_column INT');
    expect(leading).toContain('INSERT INTO dst (\n  a\n  , b\n  , c\n  , d\n  , e\n)');
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

  it('preserves source-line attachment for comments around list and statement breaks', () => {
    const attached = formatSql(
      "select 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', -- hello\n1;",
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    expect(attached).toBe([
      'SELECT',
      "  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', -- hello",
      '  1;',
    ].join('\n'));

    const standalone = formatSql(
      'select a,\n-- standalone\nb from t;',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    expect(standalone).toBe([
      'SELECT',
      '  a,',
      '  -- standalone',
      '  b',
      'FROM t;',
    ].join('\n'));

    const statements = formatSql(
      'select 1; -- first\nselect 2;',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    expect(statements).toBe([
      'SELECT 1; -- first',
      '',
      'SELECT 2;',
    ].join('\n'));

    const nextStatementComment = formatSql(
      'select 1;\n-- next statement\nselect 2;',
      'spark',
      placeholders,
      configuration,
      editor,
    ).text;
    expect(nextStatementComment).toBe([
      'SELECT 1;',
      '',
      '-- next statement',
      'SELECT 2;',
    ].join('\n'));

    expect(formatSql(attached, 'spark', placeholders, configuration, editor).text).toBe(attached);
    expect(formatSql(statements, 'spark', placeholders, configuration, editor).text).toBe(statements);
  });

  it.each(['', '\n', '\r\n'] as const)('accepts a trailing line comment with %j final EOL', (finalEol) => {
    const result = formatSql(
      `select 'xx', 1;  -- hello${finalEol}`,
      'spark',
      placeholders,
      configuration,
      { ...editor, eol: finalEol === '\r\n' ? '\r\n' : '\n' },
    ).text;

    expect(result).toBe("SELECT 'xx', 1; -- hello");
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
      { ...configuration, maxLineWidth: 300, layoutMode: 'expanded' },
      editor,
    ).text;

    expect(inline).toContain('SELECT CASE WHEN flag = 1 THEN a ELSE b END AS result');
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

  it('counts top-level WHEN and ELSE branches while keeping nested CASE counts independent', () => {
    const fourBranches = formatSql(
      'select case when a=1 then a when b=2 then b when c=3 then c else d end as result',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const fiveBranches = formatSql(
      'select case when a=1 then a when b=2 then b when c=3 then c when d=4 then d else e end as result',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const nested = formatSql(
      'select case when a=1 then case when x=1 then x when y=2 then y when z=3 then z when q=4 then q else r end else b end as result',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300, maxInlineExpressionDepth: 20 },
      editor,
    ).text;

    expect(fourBranches).toContain('CASE WHEN a = 1 THEN a WHEN b = 2 THEN b WHEN c = 3 THEN c ELSE d END');
    expect(fiveBranches).toContain([
      'CASE',
      '    WHEN a = 1 THEN a',
      '    WHEN b = 2 THEN b',
      '    WHEN c = 3 THEN c',
      '    WHEN d = 4 THEN d',
      '    ELSE e',
      '  END AS result',
    ].join('\n'));
    expect(nested).toContain([
      'CASE WHEN a = 1 THEN CASE',
      '    WHEN x = 1 THEN x',
      '    WHEN y = 2 THEN y',
      '    WHEN z = 3 THEN z',
      '    WHEN q = 4 THEN q',
      '    ELSE r',
      '  END ELSE b END AS result',
    ].join('\n'));
  });

  it('does not apply maxInlineItems to local argument, IN, or OPTIONS lists', () => {
    const local = formatSql(
      'select array(1,2,3,4,5) from t where value in (1,2,3,4,5)',
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;
    const options = formatSql(
      "create table option_items (id int) using parquet options('a'='1','b'='2','c'='3','d'='4','e'='5')",
      'spark',
      placeholders,
      { ...configuration, maxLineWidth: 300 },
      editor,
    ).text;

    expect(local).toContain('ARRAY(1, 2, 3, 4, 5)');
    expect(local).toContain('WHERE value IN (1, 2, 3, 4, 5)');
    expect(options).toContain("OPTIONS ('a' = '1', 'b' = '2', 'c' = '3', 'd' = '4', 'e' = '5')");
  });

  it.each(SQL_DIALECTS)('expands CASE expressions for the %s dialect', (dialect) => {
    const result = formatSql(
      "select case when 1=1 then 'yes' else 'no' end as result",
      dialect,
      placeholders,
      { ...configuration, layoutMode: 'expanded' },
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
