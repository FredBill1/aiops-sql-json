import { describe, expect, it } from 'vitest';

import type { SqlFormatConfiguration } from '../../src/config';
import type { SqlDialect } from '../../src/sql';
import { formatSql } from '../../src/sqlFormatting';

interface FunctionSpacingCase {
  dialect: SqlDialect;
  functionName: string;
  name: string;
  sql: string;
}

const configuration: SqlFormatConfiguration = {
  maxLineWidth: 300,
  maxInlineExpressionDepth: 20,
  maxInlineItems: 20,
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

const cases: readonly FunctionSpacingCase[] = [
  {
    dialect: 'spark',
    functionName: 'SPLIT',
    name: 'reported TRIM FROM expression',
    sql: "SELECT TRIM(BOTH '[]' FROM SPLIT('t1,t2', ',')[0]) AS a;",
  },
  {
    dialect: 'spark',
    functionName: 'SUBSTRING',
    name: 'SUBSTRING keyword function',
    sql: 'SELECT SUBSTRING(value, 1, 2) FROM source_table;',
  },
  {
    dialect: 'spark',
    functionName: 'LEFT',
    name: 'LEFT keyword function',
    sql: 'SELECT LEFT(value, 1) FROM source_table;',
  },
  {
    dialect: 'spark',
    functionName: 'RIGHT',
    name: 'RIGHT keyword function',
    sql: 'SELECT RIGHT(value, 1) FROM source_table;',
  },
  {
    dialect: 'spark',
    functionName: 'WINDOW',
    name: 'WINDOW keyword function',
    sql: "SELECT WINDOW(event_time, '10 minutes') FROM events;",
  },
  {
    dialect: 'spark',
    functionName: 'RANGE',
    name: 'table function after FROM',
    sql: 'SELECT * FROM RANGE(10);',
  },
  {
    dialect: 'spark',
    functionName: 'EXPLODE',
    name: 'generator table function after FROM',
    sql: 'SELECT * FROM EXPLODE(ARRAY(1, 2));',
  },
  {
    dialect: 'spark',
    functionName: 'RANGE',
    name: 'table function after JOIN',
    sql: 'SELECT * FROM RANGE(10) r JOIN RANGE(5) s ON r.id = s.id;',
  },
  {
    dialect: 'hive',
    functionName: 'SPLIT',
    name: 'function expression immediately after TRIM FROM',
    sql: "SELECT TRIM(BOTH 'x' FROM SPLIT('a,b', ',')[0]);",
  },
  {
    dialect: 'flink',
    functionName: 'SUBSTRING',
    name: 'SUBSTRING keyword function',
    sql: 'SELECT SUBSTRING(value, 1, 2) FROM source_table;',
  },
  {
    dialect: 'flink',
    functionName: 'LEFT',
    name: 'LEFT keyword function',
    sql: 'SELECT LEFT(value, 1) FROM source_table;',
  },
  {
    dialect: 'flink',
    functionName: 'RIGHT',
    name: 'RIGHT keyword function',
    sql: 'SELECT RIGHT(value, 1) FROM source_table;',
  },
  {
    dialect: 'flink',
    functionName: 'ROW_NUMBER',
    name: 'ROW_NUMBER keyword function',
    sql: 'SELECT ROW_NUMBER() OVER () FROM source_table;',
  },
  {
    dialect: 'flink',
    functionName: 'SORT',
    name: 'SORT keyword function',
    sql: 'SELECT SORT(values_array) FROM source_table;',
  },
  {
    dialect: 'flink',
    functionName: 'SUBSTRING',
    name: 'function expression immediately after TRIM FROM',
    sql: "SELECT TRIM(BOTH FROM SUBSTRING('text' FROM 1 FOR 2));",
  },
  {
    dialect: 'flink',
    functionName: 'TABLE',
    name: 'TABLE function wrapper after FROM',
    sql: 'SELECT * FROM TABLE(my_table_function(1));',
  },
  {
    dialect: 'mysql',
    functionName: 'INSERT',
    name: 'INSERT keyword function',
    sql: "SELECT INSERT(value, 1, 2, 'x') FROM source_table;",
  },
  {
    dialect: 'mysql',
    functionName: 'LEFT',
    name: 'LEFT keyword function',
    sql: 'SELECT LEFT(value, 1) FROM source_table;',
  },
  {
    dialect: 'mysql',
    functionName: 'RIGHT',
    name: 'RIGHT keyword function',
    sql: 'SELECT RIGHT(value, 1) FROM source_table;',
  },
  {
    dialect: 'mysql',
    functionName: 'ROW_NUMBER',
    name: 'ROW_NUMBER keyword function',
    sql: 'SELECT ROW_NUMBER() OVER () FROM source_table;',
  },
  {
    dialect: 'mysql',
    functionName: 'SUBSTRING',
    name: 'SUBSTRING keyword function',
    sql: 'SELECT SUBSTRING(value, 1, 2) FROM source_table;',
  },
  {
    dialect: 'mysql',
    functionName: 'WEIGHT_STRING',
    name: 'WEIGHT_STRING keyword function',
    sql: 'SELECT WEIGHT_STRING(value) FROM source_table;',
  },
  {
    dialect: 'mysql',
    functionName: 'SUBSTRING',
    name: 'function expression immediately after TRIM FROM',
    sql: "SELECT TRIM(BOTH 'x' FROM SUBSTRING('text', 1, 2));",
  },
  {
    dialect: 'mysql',
    functionName: 'JSON_TABLE',
    name: 'JSON_TABLE after FROM',
    sql: "SELECT * FROM JSON_TABLE('[1]', '$[*]' COLUMNS(value INT PATH '$')) jt;",
  },
  {
    dialect: 'mysql',
    functionName: 'JSON_TABLE',
    name: 'JSON_TABLE after JOIN',
    sql: "SELECT * FROM source_table s JOIN JSON_TABLE('[1]', '$[*]' COLUMNS(value INT PATH '$')) jt ON true;",
  },
  {
    dialect: 'postgresql',
    functionName: 'LEFT',
    name: 'LEFT keyword function',
    sql: 'SELECT LEFT(value, 1) FROM source_table;',
  },
  {
    dialect: 'postgresql',
    functionName: 'RIGHT',
    name: 'RIGHT keyword function',
    sql: 'SELECT RIGHT(value, 1) FROM source_table;',
  },
  {
    dialect: 'postgresql',
    functionName: 'SUBSTRING',
    name: 'SUBSTRING keyword function',
    sql: 'SELECT SUBSTRING(value, 1, 2) FROM source_table;',
  },
  {
    dialect: 'postgresql',
    functionName: 'SPLIT_PART',
    name: 'function expression immediately after TRIM FROM',
    sql: "SELECT TRIM(BOTH 'x' FROM SPLIT_PART('a,b', ',', 1));",
  },
  {
    dialect: 'postgresql',
    functionName: 'GENERATE_SERIES',
    name: 'set-returning function after FROM',
    sql: 'SELECT * FROM GENERATE_SERIES(1, 3);',
  },
  {
    dialect: 'postgresql',
    functionName: 'GENERATE_SERIES',
    name: 'set-returning function after JOIN',
    sql: 'SELECT * FROM GENERATE_SERIES(1, 3) a JOIN GENERATE_SERIES(1, 2) b ON true;',
  },
  {
    dialect: 'trino',
    functionName: 'MERGE',
    name: 'MERGE keyword aggregate function',
    sql: 'SELECT MERGE(value) FROM source_table;',
  },
  {
    dialect: 'trino',
    functionName: 'SUBSTRING',
    name: 'SUBSTRING keyword function',
    sql: 'SELECT SUBSTRING(value, 1, 2) FROM source_table;',
  },
  {
    dialect: 'trino',
    functionName: 'SPLIT',
    name: 'function expression immediately after TRIM FROM',
    sql: "SELECT TRIM(BOTH 'x' FROM SPLIT('a,b', ',')[1]);",
  },
  {
    dialect: 'trino',
    functionName: 'UNNEST',
    name: 'UNNEST after FROM',
    sql: 'SELECT * FROM UNNEST(ARRAY[1, 2]) AS u(value);',
  },
  {
    dialect: 'trino',
    functionName: 'UNNEST',
    name: 'UNNEST after JOIN',
    sql: 'SELECT * FROM (VALUES 1) t(value) CROSS JOIN UNNEST(ARRAY[1, 2]) AS u(item);',
  },
  {
    dialect: 'impala',
    functionName: 'LEFT',
    name: 'LEFT keyword function',
    sql: 'SELECT LEFT(value, 1) FROM source_table;',
  },
  {
    dialect: 'impala',
    functionName: 'RIGHT',
    name: 'RIGHT keyword function',
    sql: 'SELECT RIGHT(value, 1) FROM source_table;',
  },
  {
    dialect: 'impala',
    functionName: 'SUBSTRING',
    name: 'SUBSTRING keyword function',
    sql: 'SELECT SUBSTRING(value, 1, 2) FROM source_table;',
  },
  {
    dialect: 'impala',
    functionName: 'SPLIT_PART',
    name: 'function expression immediately after TRIM FROM',
    sql: "SELECT TRIM(BOTH 'x' FROM SPLIT_PART('a,b', ',', 1));",
  },
  {
    dialect: 'generic',
    functionName: 'SUBSTRING',
    name: 'function expression immediately after TRIM FROM',
    sql: "SELECT TRIM(BOTH 'x' FROM SUBSTRING('text', 1, 2));",
  },
];

// These are deliberately red acceptance tests: formatting must keep function-call
// parentheses attached, including keyword-shaped and table-valued functions.
describe('adversarial SQL function-call formatting', () => {
  it.each(cases)('$dialect: $name', ({ dialect, functionName, sql }) => {
    const formatted = formatSql(sql, dialect, [], configuration, editor).text.toUpperCase();
    expect(formatted, sql).toContain(`${functionName}(`);
  });
});
