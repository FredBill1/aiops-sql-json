import { describe, expect, it } from 'vitest';

import { analyzeSql, SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import { analyzeSqlSemantics } from '../../src/sqlSchemaCore';

interface MissingDiagnosticCase {
  dialects: readonly SqlDialect[];
  name: string;
  sql: string;
}

const allDialects: readonly SqlDialect[] = SQL_DIALECTS;
const withoutMySql = SQL_DIALECTS.filter((dialect) => dialect !== 'mysql');

const cases: readonly MissingDiagnosticCase[] = [
  {
    dialects: allDialects,
    name: 'alias inside a parenthesized expression',
    sql: 'SELECT (1 AS a) AS b;',
  },
  {
    dialects: allDialects,
    name: 'alias inside a parenthesized expression without an outer alias',
    sql: 'SELECT (1 AS a);',
  },
  {
    dialects: allDialects,
    name: 'alias inside nested parenthesized expressions',
    sql: 'SELECT ((1 AS a)) AS b;',
  },
  {
    dialects: allDialects,
    name: 'alias inside a scalar function argument',
    sql: 'SELECT ABS(1 AS a);',
  },
  {
    dialects: allDialects,
    name: 'alias inside an arithmetic operand',
    sql: 'SELECT 1 + (2 AS a);',
  },
  {
    dialects: allDialects,
    name: 'alias inside a CASE result',
    sql: 'SELECT CASE WHEN true THEN (1 AS a) ELSE 2 END;',
  },
  {
    dialects: allDialects,
    name: 'missing first function argument',
    sql: 'SELECT COALESCE(, 1);',
  },
  {
    dialects: allDialects,
    name: 'missing first select-list item',
    sql: 'SELECT , 1;',
  },
  {
    dialects: allDialects,
    name: 'missing first row item',
    sql: 'SELECT (, 1);',
  },
  {
    dialects: allDialects,
    name: 'missing first array item',
    sql: 'SELECT ARRAY(, 1);',
  },
  {
    dialects: allDialects,
    name: 'missing first IN-list item',
    sql: 'SELECT 1 WHERE 1 IN (, 2);',
  },
  {
    dialects: allDialects,
    name: 'bare SELECT used as a FROM relation',
    sql: 'SELECT 1 FROM SELECT 2;',
  },
  {
    dialects: allDialects,
    name: 'bare SELECT used as a wildcard FROM relation',
    sql: 'SELECT * FROM SELECT 1;',
  },
  {
    dialects: allDialects,
    name: 'adjacent SELECT statements without a terminator',
    sql: 'SELECT 1 SELECT 2;',
  },
  {
    dialects: allDialects,
    name: 'three adjacent SELECT statements without terminators',
    sql: 'SELECT 1 SELECT 2 SELECT 3;',
  },
  {
    dialects: allDialects,
    name: 'adjacent aliased SELECT statements without a terminator',
    sql: 'SELECT 1 AS a SELECT 2 AS b;',
  },
  {
    dialects: allDialects,
    name: 'AS without an alias',
    sql: 'SELECT 1 AS;',
  },
  {
    dialects: allDialects,
    name: 'GROUP without BY',
    sql: 'SELECT 1 GROUP;',
  },
  {
    dialects: allDialects,
    name: 'GROUP BY without an expression',
    sql: 'SELECT 1 GROUP BY;',
  },
  {
    dialects: allDialects,
    name: 'ORDER without BY',
    sql: 'SELECT 1 ORDER;',
  },
  {
    dialects: allDialects,
    name: 'LIMIT without a value',
    sql: 'SELECT 1 LIMIT;',
  },
  {
    dialects: allDialects,
    name: 'OFFSET without a value',
    sql: 'SELECT 1 OFFSET;',
  },
  {
    dialects: allDialects,
    name: 'WINDOW without a definition',
    sql: 'SELECT 1 WINDOW;',
  },
  {
    dialects: allDialects,
    name: 'IN without a value list or query',
    sql: 'SELECT 1 WHERE 1 IN;',
  },
  {
    dialects: allDialects,
    name: 'empty IN list',
    sql: 'SELECT 1 WHERE 1 IN ();',
  },
  {
    dialects: allDialects,
    name: 'empty parenthesized select expression',
    sql: 'SELECT ();',
  },
  {
    dialects: allDialects,
    name: 'SELECT keyword used as a scalar expression',
    sql: 'SELECT (SELECT);',
  },
  {
    dialects: allDialects,
    name: 'aliases inside a parenthesized row expression',
    sql: 'SELECT (1 AS a, 2 AS b);',
  },
  {
    dialects: allDialects,
    name: 'incomplete SELECT inside a derived table',
    sql: 'SELECT 1 FROM (SELECT);',
  },
  {
    dialects: allDialects,
    name: 'NOT IN without a value list or query',
    sql: 'SELECT 1 WHERE 1 NOT IN;',
  },
  {
    dialects: allDialects,
    name: 'CTE followed by an incomplete main query',
    sql: 'WITH c AS (SELECT 1) SELECT;',
  },
  {
    dialects: allDialects,
    name: 'INSERT source containing adjacent SELECT statements',
    sql: 'INSERT INTO target_table SELECT 1 SELECT 2;',
  },
  {
    dialects: allDialects,
    name: 'empty VALUES row',
    sql: 'VALUES ();',
  },
  {
    dialects: allDialects,
    name: 'END outside a CASE expression',
    sql: 'SELECT 1 END;',
  },
  {
    dialects: allDialects,
    name: 'OVER without a window specification',
    sql: 'SELECT 1 OVER;',
  },
  {
    dialects: allDialects,
    name: 'IS without a predicate',
    sql: 'SELECT 1 IS;',
  },
  {
    dialects: allDialects,
    name: 'NOT without a predicate',
    sql: 'SELECT 1 NOT;',
  },
  {
    dialects: allDialects,
    name: 'derived table AS without an alias',
    sql: 'SELECT 1 FROM (SELECT 1) AS;',
  },
  {
    dialects: allDialects,
    name: 'empty USING column list',
    sql: 'SELECT 1 FROM (SELECT 1 AS a) t JOIN (SELECT 2 AS a) u USING ();',
  },
  {
    dialects: withoutMySql,
    name: 'missing first VALUES-row item',
    sql: 'VALUES (, 1);',
  },
  {
    dialects: ['spark', 'hive', 'flink', 'postgresql', 'trino', 'impala'],
    name: 'adjacent VALUES clauses',
    sql: 'VALUES (1) VALUES (2);',
  },
  {
    dialects: ['mysql', 'postgresql', 'trino', 'impala', 'generic'],
    name: 'empty EXISTS operand',
    sql: 'SELECT EXISTS ();',
  },
  {
    dialects: ['spark'],
    name: 'WITH after a complete projection',
    sql: 'SELECT 1 WITH;',
  },
  {
    dialects: ['spark'],
    name: 'SELECT used as a WHERE expression',
    sql: 'SELECT 1 WHERE SELECT 2;',
  },
  {
    dialects: ['spark'],
    name: 'UNION without a right query',
    sql: 'SELECT 1 UNION;',
  },
  {
    dialects: ['spark'],
    name: 'INTERSECT without a right query',
    sql: 'SELECT 1 INTERSECT;',
  },
  {
    dialects: ['spark', 'mysql'],
    name: 'EXCEPT without a right query',
    sql: 'SELECT 1 EXCEPT;',
  },
  {
    dialects: ['spark'],
    name: 'WHERE NOT without an operand',
    sql: 'SELECT 1 WHERE NOT;',
  },
  {
    dialects: ['spark'],
    name: 'repeated UNION without an intervening query',
    sql: 'SELECT 1 UNION UNION SELECT 2;',
  },
  {
    dialects: ['postgresql'],
    name: 'DISTINCT without a select expression',
    sql: 'SELECT DISTINCT;',
  },
  {
    dialects: ['postgresql', 'generic'],
    name: 'VALUES without a row',
    sql: 'VALUES;',
  },
  {
    dialects: ['impala'],
    name: 'alias inside an unknown function argument',
    sql: 'SELECT f(1 AS a);',
  },
  {
    dialects: ['impala'],
    name: 'missing first unknown-function argument',
    sql: 'SELECT f(, 1);',
  },
  {
    dialects: ['mysql'],
    name: 'CTE without a main statement',
    sql: 'WITH c AS (SELECT 1);',
  },
  {
    dialects: ['mysql'],
    name: 'two ON clauses on one join',
    sql: 'SELECT 1 FROM (SELECT 1) t JOIN (SELECT 2) u ON true ON false;',
  },
  {
    dialects: ['mysql'],
    name: 'two ORDER BY clauses',
    sql: 'SELECT 1 FROM t ORDER BY a ORDER BY b;',
  },
  {
    dialects: ['mysql'],
    name: 'two LIMIT clauses',
    sql: 'SELECT 1 FROM t LIMIT 1 LIMIT 2;',
  },
  {
    dialects: ['mysql'],
    name: 'ALTER TABLE without an action',
    sql: 'ALTER TABLE t;',
  },
];

const expandedCases = cases.flatMap(({ dialects, name, sql }) => (
  dialects.map((dialect) => ({ dialect, name, sql }))
));

const emptySchema = { tables: [], issues: [] } as const;

// These are deliberately red black-box acceptance tests. Every statement is invalid,
// yet schema-enabled analysis currently produces neither syntax nor semantic diagnostics.
describe('round three adversarial schema validation', () => {
  it.each(expandedCases)('$dialect: $name', ({ dialect, sql }) => {
    const syntaxIssueCount = analyzeSql(sql, dialect, []).issues.length;
    const semanticIssueCount = analyzeSqlSemantics(sql, dialect, [], emptySchema, []).length;

    expect({ syntaxIssueCount, semanticIssueCount }, sql).not.toEqual({
      syntaxIssueCount: 0,
      semanticIssueCount: 0,
    });
  });
});
