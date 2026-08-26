import { describe, expect, it } from 'vitest';

import { compilePlaceholderPatterns } from '../../src/patterns';
import { analyzeSql, SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import { parseSqlAst, walkSqlAst, type SqlAstNode } from '../../src/sqlAst';
import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  getSqlScopeInfo,
  getSqlSymbolAtOffset,
  parseDdlSchema,
} from '../../src/sqlSchemaCore';

const patterns = compilePlaceholderPatterns(['\\$\\{[^}]+\\}', '\\$\\w+']).patterns;
const ddl = `CREATE TABLE readings (id INT, label VARCHAR(30), amount DOUBLE, backup DOUBLE, ts TIMESTAMP(3));
CREATE TABLE adjustments (id INT, delta DOUBLE);`;
const source = 'file:///anonymous-model-schema.sql';
const schemas = new Map(SQL_DIALECTS.map((dialect) => [dialect, createSchemaSnapshot([parseDdlSchema(ddl, dialect, source)])]));

function issues(sql: string, dialect: SqlDialect = 'spark') {
  expect(analyzeSql(sql, dialect, patterns).issues).toEqual([]);
  return analyzeSqlSemantics(sql, dialect, patterns, schemas.get(dialect)!, []);
}

function symbol(sql: string, needle: string, dialect: SqlDialect = 'spark', last = false) {
  const offset = last ? sql.lastIndexOf(needle) : sql.indexOf(needle);
  expect(offset).toBeGreaterThanOrEqual(0);
  return getSqlSymbolAtOffset(sql, offset, dialect, patterns, schemas.get(dialect)!);
}

function scope(sql: string, dialect: SqlDialect = 'spark', offset = sql.indexOf('*')) {
  return getSqlScopeInfo(sql, offset, dialect, patterns, schemas.get(dialect)!);
}

function astNodes(sql: string, dialect: SqlDialect) {
  const root = parseSqlAst(sql, dialect, patterns)?.statements[0];
  expect(root).toBeDefined();
  const nodes: SqlAstNode[] = [];
  walkSqlAst(root!, (node) => nodes.push(node));
  return nodes;
}

describe('source intervals and placeholder isolation', () => {
  it.each(SQL_DIALECTS)('distinguishes missing metadata from source offset zero in %s', (dialect) => {
    const nodes = astNodes('amount + CAST(backup AS DOUBLE)', dialect);
    expect(nodes[0]?.start).toBe(0);
    expect(nodes.find((node) => node.role === 'identifier' && node.name === 'amount')?.ownStart).toBe(0);
    const cast = nodes.find((node) => node.kind === 'cast' || node.kind === 'tryCast');
    expect(cast?.start).toBeGreaterThan(0);
    expect(nodes.find((node) => node.role === 'data-type')).toMatchObject({ start: 0, end: 0 });
  });

  it.each(SQL_DIALECTS)('preserves exact UTF-16/CRLF operand and definition ranges in %s', (dialect) => {
    const sql = "-- 😀 $batch\r\nSELECT '$batch' AS marker, COALESCE(CAST(r.amount AS DOUBLE), 0) FROM readings r";
    expect(issues(sql, dialect)).toEqual([]);
    const resolved = symbol(sql, 'amount', dialect);
    expect(resolved?.reference).toEqual({ start: sql.indexOf('amount'), end: sql.indexOf('amount') + 6 });
    expect(resolved?.type).toMatch(/double/i);
    const origin = resolved?.definitions[0]?.location;
    expect(origin?.source).toBe(source);
    expect(ddl.slice(origin?.selectionStart, origin?.selectionEnd)).toBe('amount');
    expect(symbol(sql, 'r.amount', dialect)?.kind).toBe('relation-alias');
  });

  it.each(SQL_DIALECTS)('checks unaffected siblings of a dynamic reference in %s', (dialect) => {
    const sql = 'SELECT ${field} + amount + missing FROM readings WHERE id = $batch AND absent = 1';
    expect(issues(sql, dialect).map((issue) => issue.code)).toEqual(['unknown-column', 'unknown-column']);
    expect(symbol(sql, 'amount', dialect)?.definitions[0]?.location.source).toBe(source);
    expect(symbol(sql, '${field}', dialect)).toBeUndefined();
  });

  it.each(SQL_DIALECTS)('keeps a fixed output shape when only its value is dynamic in %s', (dialect) => {
    const sql = "SELECT * FROM (SELECT '$batch' AS marker, amount FROM readings) d";
    const output = scope(sql, dialect).relations[0];
    expect(output?.unresolved).toBe(false);
    expect(output?.columns.map((column) => column.name)).toEqual(['marker', 'amount']);
    expect(output?.columns[0]?.typeFamily).toBe('unknown');
    expect(issues(sql.replace('SELECT *', 'SELECT d.missing'), dialect).map((issue) => issue.code)).toEqual(['unknown-column']);
  });

  it.each(SQL_DIALECTS)('keeps dynamic INSERT targets independent of source checking in %s', (dialect) => {
    const sql = 'INSERT INTO ${namespace}.destination (amount) SELECT CAST(r.amount AS DOUBLE) FROM readings r';
    expect(issues(sql, dialect)).toEqual([]);
    expect(symbol(sql, 'amount AS', dialect)?.kind).toBe('column');
    expect(symbol(sql, 'r.amount', dialect)?.kind).toBe('relation-alias');
  });
});

describe('statement-owned scopes', () => {
  it.each(SQL_DIALECTS)('resolves set outputs, both origins, and CTE scope in %s', (dialect) => {
    const sql = 'WITH c AS (SELECT amount FROM readings) SELECT amount FROM c UNION ALL SELECT delta FROM adjustments ORDER BY amount';
    expect(issues(sql, dialect)).toEqual([]);
    const output = symbol(sql, 'amount', dialect, true);
    expect(output?.definitions.map((definition) => definition.name)).toEqual(['amount', 'delta']);
    expect(output?.definitions.every((definition) => definition.location.source === source)).toBe(true);
    expect(scope(sql, dialect, sql.lastIndexOf('amount')).fields).toEqual(['amount']);
    expect(issues(sql.replace('ORDER BY amount', 'ORDER BY adjustments.delta'), dialect).map((issue) => issue.code)).toEqual(['unknown-qualifier']);
    expect(issues(sql.replace('ORDER BY amount', 'ORDER BY delta'), dialect).map((issue) => issue.code)).toEqual(['unknown-column']);
  });

  it.each(['INTERSECT', 'EXCEPT'])('uses the same output namespace for %s', (operator) => {
    const sql = `SELECT amount FROM readings ${operator} SELECT delta FROM adjustments ORDER BY amount`;
    expect(issues(sql)).toEqual([]);
    expect(symbol(sql, 'amount', 'spark', true)?.definitions).toHaveLength(2);
  });

  it('does not resolve window inputs through projection aliases', () => {
    const sql = 'SELECT amount AS not_an_input, SUM(amount) OVER w FROM readings WINDOW w AS (PARTITION BY not_an_input ORDER BY id)';
    expect(issues(sql).map((issue) => issue.code)).toEqual(['unknown-column']);
  });

  it('does not let a later JOIN leak into an earlier ON predicate', () => {
    const sql = 'SELECT r.id FROM readings r JOIN adjustments a ON r.id = later.id JOIN adjustments later ON r.id = later.id';
    expect(issues(sql).map((issue) => issue.code)).toEqual(['unknown-qualifier']);
    const earlier = scope(sql, 'spark', sql.indexOf('later.id'));
    expect(earlier.relations.some((relation) => relation.aliases.includes('later'))).toBe(false);
  });

  it('preserves CTE shadowing and does not expose a CTE in the next statement', () => {
    const sql = 'WITH c AS (SELECT amount FROM readings) SELECT * FROM (WITH c AS (SELECT delta FROM adjustments) SELECT delta FROM c) d; SELECT amount FROM c';
    expect(issues(sql).map((issue) => issue.code)).toEqual(['unknown-table']);
    expect(symbol(sql, 'delta FROM c')?.definitions[0]?.name).toBe('delta');
  });

  it.each(['mysql', 'postgresql'] as const)('accepts WITH-owned DML but still requires statement separators in %s', (dialect) => {
    const sql = 'WITH c AS (SELECT delta FROM adjustments) UPDATE readings SET amount = (SELECT delta FROM c)';
    expect(issues(sql, dialect)).toEqual([]);
    expect(analyzeSql('SELECT id FROM readings SELECT id FROM adjustments', dialect, []).issues.length).toBeGreaterThan(0);
    expect(analyzeSql('SELECT ABS(amount AS x) FROM readings', dialect, []).issues.length).toBeGreaterThan(0);
  });
});

describe('relation transforms share navigation, completion and schema outputs', () => {
  it.each(['spark', 'trino'] as const)('models multi-aggregate PIVOT input/output columns in %s', (dialect) => {
    const sql = "SELECT * FROM readings PIVOT (SUM(amount) AS total, MAX(backup) AS peak FOR label IN ('x' AS one, 'y' AS two)) p";
    expect(issues(sql, dialect)).toEqual([]);
    const output = scope(sql, dialect);
    expect(output.fields).toEqual(['id', 'ts', 'one_total', 'one_peak', 'two_total', 'two_peak']);
    expect(output.relations[0]?.columns.find((column) => column.name === 'one_total')?.typeFamily).toBe('number');
    expect(symbol(sql, 'amount', dialect)?.definitions[0]?.location.source).toBe(source);
    expect(scope(sql, dialect, sql.indexOf('SUM(')).fields).toContain('amount');
    expect(issues(sql.replace('SELECT *', 'SELECT p.amount'), dialect).map((issue) => issue.code)).toEqual(['unknown-column']);
    const generated = symbol(sql.replace('SELECT *', 'SELECT p.one_total'), 'one_total', dialect);
    expect(generated?.definitions.some((definition) => definition.name === 'amount' && definition.location.source === source)).toBe(true);
  });

  it('models UNPIVOT output declarations and source lineage', () => {
    const sql = 'SELECT * FROM readings UNPIVOT (value FOR metric IN (amount, backup)) u';
    expect(issues(sql)).toEqual([]);
    expect(scope(sql).fields).toEqual(['id', 'label', 'ts', 'metric', 'value']);
    const columns = scope(sql).relations[0]!.columns;
    expect(columns.find((column) => column.name === 'metric')?.typeFamily).toBe('string');
    const value = columns.find((column) => column.name === 'value');
    expect(value?.typeFamily).toBe('number');
    expect(value?.definitions?.filter((definition) => definition.location.source === source).map((definition) => definition.name)).toEqual(['amount', 'backup']);
    expect(issues(sql.replace('SELECT *', 'SELECT u.amount')).map((issue) => issue.code)).toEqual(['unknown-column']);
  });

  it.each(['trino', 'flink'] as const)('models MATCH_RECOGNIZE variables and measures in %s', (dialect) => {
    const sql = 'SELECT * FROM readings MATCH_RECOGNIZE (PARTITION BY label ORDER BY ts MEASURES A.amount AS measured PATTERN (A B+) DEFINE A AS A.amount > 0, B AS B.amount > A.amount) mr';
    expect(issues(sql, dialect)).toEqual([]);
    expect(scope(sql, dialect).fields).toEqual(['label', 'measured']);
    expect(scope(sql, dialect).relations[0]?.columns[1]?.typeFamily).toBe('number');
    expect(symbol(sql, 'amount', dialect)?.definitions[0]?.location.source).toBe(source);
    expect(issues(sql.replace('SELECT *', 'SELECT A.amount'), dialect).map((issue) => issue.code)).toEqual(['unknown-qualifier']);
    expect(issues(sql.replace('MEASURES A.amount', 'MEASURES Z.amount'), dialect).map((issue) => issue.code)).toEqual(['unknown-qualifier']);
  });

  it.each(['trino', 'flink'] as const)('types pattern navigation functions in %s', (dialect) => {
    const sql = 'SELECT * FROM readings MATCH_RECOGNIZE (PARTITION BY label ORDER BY ts MEASURES FIRST(A.amount) AS first_amount, LAST(A.amount) AS last_amount PATTERN (A+) DEFINE A AS A.amount > 0) mr';
    expect(issues(sql, dialect)).toEqual([]);
    expect(scope(sql, dialect).relations[0]?.columns.slice(1).map((column) => column.typeFamily)).toEqual(['number', 'number']);
    expect(symbol(sql, 'FIRST', dialect)?.functionSignatures?.[0]).toContain('FIRST');
  });

  it('resolves implicitly true pattern variables and orders ALL ROWS output columns', () => {
    const sql = 'SELECT * FROM readings MATCH_RECOGNIZE (PARTITION BY label ORDER BY ts MEASURES B.amount AS measured ALL ROWS PER MATCH PATTERN (A B) DEFINE A AS A.amount > 0) mr';
    expect(issues(sql, 'trino')).toEqual([]);
    expect(scope(sql, 'trino').fields).toEqual(['label', 'ts', 'measured', 'id', 'amount', 'backup']);
  });
});

describe('DML read/write namespaces', () => {
  it('builds clause-subquery completion scopes even without diagnostic traversal', () => {
    const sql = 'UPDATE readings SET amount = (SELECT delta FROM adjustments WHERE id = 1)';
    expect(issues(sql, 'postgresql')).toEqual([]);
    expect(scope(sql, 'postgresql', sql.indexOf('delta')).fields).toEqual(['id', 'delta']);
    expect(symbol(sql, 'delta', 'postgresql')?.definitions[0]?.name).toBe('delta');
  });

  it('exposes RETURNING projections through a data-changing CTE', () => {
    const sql = 'WITH changed AS (UPDATE readings SET amount = 1 RETURNING amount AS new_amount) SELECT * FROM changed';
    expect(issues(sql, 'postgresql')).toEqual([]);
    const columns = scope(sql, 'postgresql').relations[0]?.columns;
    expect(columns?.map((column) => column.name)).toEqual(['new_amount']);
    expect(columns?.[0]?.typeFamily).toBe('number');
    expect(symbol(sql, 'new_amount', 'postgresql')?.definitions[0]?.name).toBe('amount');
  });

  it('binds PostgreSQL assignments to the target and FROM expressions to the source', () => {
    const sql = 'UPDATE readings r SET amount = a.delta FROM adjustments a WHERE r.id = a.id RETURNING r.amount';
    expect(issues(sql, 'postgresql')).toEqual([]);
    expect(symbol(sql, 'amount', 'postgresql')?.definitions[0]?.name).toBe('amount');
    expect(symbol(sql, 'delta', 'postgresql')?.definitions[0]?.name).toBe('delta');
    expect(issues(sql.replace('SET amount', 'SET delta'), 'postgresql').map((issue) => issue.code)).toEqual(['unknown-column']);
    expect(issues(sql.replace('a.delta FROM', 'r.label FROM'), 'postgresql').map((issue) => issue.code)).toContain('incompatible-type');
  });

  it('allows MySQL joined targets without treating aliases as physical tables', () => {
    const sql = 'WITH c AS (SELECT id FROM adjustments) DELETE r FROM readings r JOIN c ON r.id = c.id';
    expect(issues(sql, 'mysql')).toEqual([]);
    const update = 'UPDATE readings r JOIN adjustments a ON r.id = a.id SET a.delta = r.amount';
    expect(issues(update, 'mysql')).toEqual([]);
    expect(symbol(update, 'delta', 'mysql')?.definitions[0]?.name).toBe('delta');
  });

  it('keeps EXCLUDED qualified-only and local to the conflict update', () => {
    const sql = 'INSERT INTO readings (id, amount) VALUES (1, 2) ON CONFLICT (id) WHERE id > 0 DO UPDATE SET amount = EXCLUDED.amount WHERE amount > 0 RETURNING amount';
    expect(issues(sql, 'postgresql')).toEqual([]);
    expect(symbol(sql, 'amount WHERE', 'postgresql')?.definitions[0]?.name).toBe('amount');
    expect(issues(sql.replace('RETURNING amount', 'RETURNING EXCLUDED.amount'), 'postgresql').map((issue) => issue.code)).toEqual(['unknown-qualifier']);
    expect(issues(sql.replace('SET amount', 'SET delta'), 'postgresql').map((issue) => issue.code)).toEqual(['unknown-column']);
    expect(scope(sql, 'postgresql', sql.indexOf('id >')).relations.some((relation) => relation.aliases.includes('excluded'))).toBe(false);
    expect(scope(sql, 'postgresql', sql.indexOf('EXCLUDED')).relations.some((relation) => relation.aliases.includes('excluded'))).toBe(true);
  });
});

describe('Flink structural table arguments', () => {
  it.each([
    ['TUMBLE', "INTERVAL '1' HOUR"],
    ['HOP', "INTERVAL '5' MINUTE, INTERVAL '1' HOUR"],
    ['CUMULATE', "INTERVAL '5' MINUTE, INTERVAL '1' HOUR"],
  ])('models %s input fields and window outputs', (name, argumentsSql) => {
    const sql = `SELECT * FROM TABLE(${name}(TABLE readings, DESCRIPTOR(ts), ${argumentsSql})) w`;
    expect(issues(sql, 'flink')).toEqual([]);
    const output = scope(sql, 'flink');
    expect(output.fields).toEqual(['id', 'label', 'amount', 'backup', 'ts', 'window_start', 'window_end', 'window_time']);
    expect(output.relations[0]?.columns.slice(-3).every((column) => column.typeFamily === 'time')).toBe(true);
    expect(symbol(sql, 'ts)', 'flink')?.definitions[0]?.name).toBe('ts');
    expect(issues(sql.replace('DESCRIPTOR(ts)', 'DESCRIPTOR(missing)'), 'flink').map((issue) => issue.code)).toEqual(['unknown-column']);
  });

  it.each([
    "SESSION(TABLE readings PARTITION BY label, DESCRIPTOR(ts), INTERVAL '1' HOUR)",
    "SESSION(TABLE readings PARTITION BY (label, id), DESCRIPTOR(ts), INTERVAL '1' HOUR)",
    "TUMBLE(DATA => TABLE readings, SIZE => INTERVAL '1' HOUR, TIMECOL => DESCRIPTOR(ts))",
    "TUMBLE(TABLE (SELECT id, ts FROM readings), DESCRIPTOR(ts), INTERVAL '1' HOUR)",
  ])('preserves relation-valued arguments in %s', (call) => {
    const sql = `SELECT * FROM ${call} w`;
    expect(issues(sql, 'flink')).toEqual([]);
    expect(scope(sql, 'flink').fields).toContain('window_start');
    expect(scope(sql, 'flink').relations[0]?.columns.find((column) => column.name === 'window_start')?.type).toMatch(/^TIMESTAMP\(3\)$/i);
    expect(symbol(sql, 'ts)', 'flink')?.definitions[0]?.location.source).toBe(source);
  });

  it('validates descriptors, arity and interval argument types', () => {
    const sql = 'SELECT * FROM TABLE(TUMBLE(TABLE readings, DESCRIPTOR(amount), 1))';
    expect(issues(sql, 'flink').map((issue) => issue.code)).toEqual(['function-argument-type', 'function-argument-type']);
    expect(issues(sql.replace(', 1)', ')'), 'flink').map((issue) => issue.code)).toContain('function-argument-count');
  });

  it('binds temporal expressions before publishing the right-hand relation', () => {
    const sql = 'SELECT r.id FROM readings r JOIN adjustments FOR SYSTEM_TIME AS OF r.ts a ON r.id = a.id';
    expect(issues(sql, 'flink')).toEqual([]);
    expect(symbol(sql, 'ts a', 'flink')?.definitions[0]?.name).toBe('ts');
    expect(issues(sql.replace('AS OF r.ts', 'AS OF a.id'), 'flink').map((issue) => issue.code)).toEqual(['unknown-qualifier']);
    expect(parseSqlAst(sql, 'trino')).toBeUndefined();
  });
});
