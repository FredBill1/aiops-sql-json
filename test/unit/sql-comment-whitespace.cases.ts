import type { SqlFormatConfiguration } from '../../src/config';
import type { SqlDialect } from '../../src/sql';

export const commentFormat: SqlFormatConfiguration = {
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

// Explicit markers survive editors that automatically trim trailing whitespace.
// Only comment suffixes are substituted; never trim SQL strings or identifiers.
export const commentCases = [
  ['reported HAVING', 'select max(a)\nfrom (\n  select 1 as a, 2 as b\n) base\nhaving\n  -- test{{ws}}\n  max(a) = 1'],
  ['before SELECT', '-- test{{ws}}\nselect 1'],
  ['after SELECT', 'select -- test{{ws}}\n1'],
  ['after expression', 'select 1 -- test{{ws}}\n'],
  ['end of file', 'select 1 -- test{{ws}}'],
  ['after semicolon at EOF', 'select 1; -- test{{ws}}'],
  ['before semicolon', 'select 1 -- test{{ws}}\n;'],
  ['between statements', 'select 1;\n-- test{{ws}}\nselect 2;'],
  ['before comma', 'select 1 -- test{{ws}}\n, 2'],
  ['after comma', 'select 1, -- test{{ws}}\n2'],
  ['before alias', 'select 1 -- test{{ws}}\nas a'],
  ['after AS', 'select 1 as -- test{{ws}}\na'],
  ['before FROM', 'select a\n-- test{{ws}}\nfrom source_table'],
  ['after FROM', 'select a from -- test{{ws}}\nsource_table'],
  ['after WHERE', 'select a from source_table where -- test{{ws}}\na = 1'],
  ['before AND', 'select a from source_table where a = 1 -- test{{ws}}\nand b = 2'],
  ['after OR', 'select a from source_table where a = 1 or -- test{{ws}}\nb = 2'],
  ['after operator', 'select 1 + -- test{{ws}}\n2'],
  ['function argument', 'select max( -- test{{ws}}\na) from source_table'],
  ['function separator', 'select coalesce(a, -- test{{ws}}\nb) from source_table'],
  ['IN list', 'select a from source_table where a in (1, -- test{{ws}}\n2)'],
  ['CASE WHEN', 'select case when -- test{{ws}}\n1 = 1 then 2 else 3 end'],
  ['CASE THEN', 'select case when 1 = 1 then -- test{{ws}}\n2 else 3 end'],
  ['CASE ELSE', 'select case when 1 = 1 then 2 else -- test{{ws}}\n3 end'],
  ['subquery close', 'select a from (select 1 as a -- test{{ws}}\n) base'],
  ['CTE body', 'with c as ( -- test{{ws}}\nselect 1 as a) select a from c'],
  ['JOIN ON', 'select t.a from source_table t join source_table u on -- test{{ws}}\nt.a = u.a'],
  ['GROUP BY', 'select a, count(*) from source_table group by -- test{{ws}}\na'],
  ['ORDER BY', 'select a from source_table order by -- test{{ws}}\na'],
  ['LIMIT', 'select a from source_table limit -- test{{ws}}\n1'],
  ['UNION ALL', 'select 1 union all -- test{{ws}}\nselect 2'],
  ['window specification', 'select ROW_NUMBER() over ( -- test{{ws}}\norder by a) from source_table'],
  ['DDL column list', 'create table comment_table (a int, -- test{{ws}}\nb int)'],
  ['INSERT SELECT', 'insert into source_table -- test{{ws}}\nselect 1, 2'],
  ['consecutive comments', 'select -- first{{ws}}\n-- second{{ws}}\n1'],
  ['empty comment', 'select 1 --{{ws}}\n'],
  ['Unicode comment', 'select 1 -- 中文注释{{ws}}\n'],
  ['SQL-looking comment', "select 1 -- 'quote' /* block */ ; select 2{{ws}}\n"],
  ['literal spaces preserved', "select 'keep  ' as a -- test{{ws}}\n"],
] as const;

export const dialectCommentCases: readonly { dialect: SqlDialect; name: string; sql: string }[] = [
  { dialect: 'mysql', name: 'hash leading', sql: '# test{{ws}}\nselect 1' },
  { dialect: 'mysql', name: 'hash EOF', sql: 'select 1 # test{{ws}}' },
  { dialect: 'mysql', name: 'hash between statements', sql: 'select 1; # test{{ws}}\nselect 2;' },
  { dialect: 'spark', name: 'SORT BY', sql: 'select a from source_table sort by -- test{{ws}}\na' },
  { dialect: 'hive', name: 'DISTRIBUTE BY', sql: 'select a from source_table distribute by -- test{{ws}}\na' },
  { dialect: 'postgresql', name: 'cast operator', sql: 'select 1:: -- test{{ws}}\ninteger' },
  { dialect: 'trino', name: 'array subscript', sql: 'select array[1, -- test{{ws}}\n2][1]' },
  { dialect: 'impala', name: 'STRAIGHT_JOIN', sql: 'select straight_join -- test{{ws}}\na from source_table' },
  { dialect: 'flink', name: 'OFFSET FETCH', sql: 'select a from source_table order by a offset 0 rows fetch next -- test{{ws}}\n1 rows only' },
];

export function commentSql(template: string, whitespace: string, eol = '\n'): string {
  return template.replaceAll('{{ws}}', whitespace).replaceAll('\n', eol);
}
