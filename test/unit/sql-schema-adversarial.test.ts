import { describe, expect, it } from 'vitest';

import { analyzeSql, SQL_DIALECTS, type SqlDialect } from '../../src/sql';
import {
  analyzeSqlSemantics,
  createSchemaSnapshot,
  parseDdlSchema,
  type SchemaSnapshot,
} from '../../src/sqlSchemaCore';

interface DialectFixture {
  ddl: readonly string[];
  expansionQuery: string;
  invalidExpansionQuery: string;
}

interface SemanticCase {
  name: string;
  sql: string;
  expectedCode: string;
}

const scalarTypes: Record<SqlDialect, { text: string; timestamp: string }> = {
  spark: { text: 'STRING', timestamp: 'TIMESTAMP' },
  hive: { text: 'STRING', timestamp: 'TIMESTAMP' },
  flink: { text: 'STRING', timestamp: 'TIMESTAMP(3)' },
  mysql: { text: 'VARCHAR(200)', timestamp: 'DATETIME' },
  postgresql: { text: 'TEXT', timestamp: 'TIMESTAMP' },
  trino: { text: 'VARCHAR', timestamp: 'TIMESTAMP' },
  impala: { text: 'STRING', timestamp: 'TIMESTAMP' },
  generic: { text: 'VARCHAR(200)', timestamp: 'TIMESTAMP' },
};

const expansionDdl: Record<SqlDialect, string> = {
  spark: 'CREATE TABLE sales.event_batches (batch_id BIGINT, tags ARRAY<STRING>);',
  hive: 'CREATE TABLE sales.event_batches (batch_id BIGINT, tags ARRAY<STRING>);',
  flink: "CREATE TABLE sales.event_batches (batch_id BIGINT, tags ARRAY<STRING>) WITH ('connector'='values');",
  mysql: 'CREATE TABLE sales.event_batches (batch_id BIGINT, payload JSON);',
  postgresql: 'CREATE TABLE sales.event_batches (batch_id BIGINT, payload JSONB);',
  trino: 'CREATE TABLE sales.event_batches (batch_id BIGINT, tags ARRAY(VARCHAR));',
  impala: 'CREATE TABLE sales.event_batches (batch_id BIGINT, tags ARRAY<STRING>);',
  generic: 'CREATE TABLE sales.event_batches (batch_id BIGINT, tags ARRAY<VARCHAR>);',
};

const expansionQueries: Record<SqlDialect, { valid: string; invalid: string }> = {
  spark: {
    valid: `SELECT b.batch_id, tag_pos, tag
FROM sales.event_batches b
LATERAL VIEW OUTER POSEXPLODE(b.tags) tag_view AS tag_pos, tag`,
    invalid: `SELECT b.batch_id, tag_view.missing_tag
FROM sales.event_batches b
LATERAL VIEW OUTER POSEXPLODE(b.tags) tag_view AS tag_pos, tag`,
  },
  hive: {
    valid: `SELECT b.batch_id, tag_pos, tag
FROM sales.event_batches b
LATERAL VIEW OUTER POSEXPLODE(b.tags) tag_view AS tag_pos, tag`,
    invalid: `SELECT b.batch_id, tag_view.missing_tag
FROM sales.event_batches b
LATERAL VIEW OUTER POSEXPLODE(b.tags) tag_view AS tag_pos, tag`,
  },
  flink: {
    valid: `SELECT b.batch_id, tag
FROM sales.event_batches AS b
CROSS JOIN UNNEST(b.tags) AS tag_view (tag)`,
    invalid: `SELECT b.batch_id, tag_view.missing_tag
FROM sales.event_batches AS b
CROSS JOIN UNNEST(b.tags) AS tag_view (tag)`,
  },
  mysql: {
    valid: `SELECT b.batch_id, tag_view.tag
FROM sales.event_batches AS b
JOIN JSON_TABLE(b.payload, '$.tags[*]' COLUMNS(tag VARCHAR(100) PATH '$')) AS tag_view ON TRUE`,
    invalid: `SELECT b.batch_id, tag_view.missing_tag
FROM sales.event_batches AS b
JOIN JSON_TABLE(b.payload, '$.tags[*]' COLUMNS(tag VARCHAR(100) PATH '$')) AS tag_view ON TRUE`,
  },
  postgresql: {
    valid: `SELECT b.batch_id, tag_view.tag
FROM sales.event_batches AS b
CROSS JOIN LATERAL jsonb_array_elements_text(b.payload -> 'tags') AS tag_view(tag)`,
    invalid: `SELECT b.batch_id, tag_view.missing_tag
FROM sales.event_batches AS b
CROSS JOIN LATERAL jsonb_array_elements_text(b.payload -> 'tags') AS tag_view(tag)`,
  },
  trino: {
    valid: `SELECT b.batch_id, tag
FROM sales.event_batches AS b
CROSS JOIN UNNEST(b.tags) AS tag_view(tag)`,
    invalid: `SELECT b.batch_id, tag_view.missing_tag
FROM sales.event_batches AS b
CROSS JOIN UNNEST(b.tags) AS tag_view(tag)`,
  },
  impala: {
    valid: `SELECT b.batch_id, tag.item
FROM sales.event_batches b, b.tags tag`,
    invalid: `SELECT b.batch_id, tag.missing_tag
FROM sales.event_batches b, b.tags tag`,
  },
  generic: {
    valid: `SELECT b.batch_id, tag
FROM sales.event_batches AS b
CROSS JOIN UNNEST(b.tags) AS tag_view(tag)`,
    invalid: `SELECT b.batch_id, tag_view.missing_tag
FROM sales.event_batches AS b
CROSS JOIN UNNEST(b.tags) AS tag_view(tag)`,
  },
};

const dialectFixtures = Object.fromEntries(SQL_DIALECTS.map((dialect) => {
  const types = scalarTypes[dialect];
  const tableSuffix = dialect === 'flink' ? " WITH ('connector'='values')" : '';
  const ddl = [
    `CREATE TABLE sales.orders (
      order_id BIGINT,
      customer_id BIGINT,
      amount DECIMAL(18, 2),
      status ${types.text},
      created_at ${types.timestamp}
    )${tableSuffix};`,
    `CREATE TABLE sales.customers (
      customer_id BIGINT,
      customer_name ${types.text},
      region_id BIGINT
    )${tableSuffix};`,
    `CREATE TABLE sales.regions (
      region_id BIGINT,
      region_name ${types.text}
    )${tableSuffix};`,
    `CREATE TABLE sales.order_items (
      order_id BIGINT,
      line_no INTEGER,
      sku ${types.text},
      quantity INTEGER
    )${tableSuffix};`,
    expansionDdl[dialect],
  ];
  return [dialect, {
    ddl,
    expansionQuery: expansionQueries[dialect].valid,
    invalidExpansionQuery: expansionQueries[dialect].invalid,
  }];
})) as unknown as Record<SqlDialect, DialectFixture>;

const validQueries = [
  {
    name: 'multi-CTE join with aggregates and a window',
    sql: `WITH customer_totals AS (
  SELECT o.customer_id,
         SUM(o.amount) AS total_amount,
         COUNT(*) AS order_count
  FROM sales.orders o
  JOIN sales.customers c ON c.customer_id = o.customer_id
  JOIN sales.order_items i ON i.order_id = o.order_id
  WHERE o.status = 'paid' AND i.quantity > 0
  GROUP BY o.customer_id
), ranked AS (
  SELECT customer_id,
         total_amount,
         ROW_NUMBER() OVER (ORDER BY total_amount DESC) AS spend_rank
  FROM customer_totals
)
SELECT r.customer_id, c.customer_name, g.region_name, r.total_amount
FROM ranked r
JOIN sales.customers c ON c.customer_id = r.customer_id
LEFT JOIN sales.regions g ON g.region_id = c.region_id
WHERE r.spend_rank <= 10`,
  },
  {
    name: 'derived aggregate joined to a correlated EXISTS subquery',
    sql: `SELECT c.customer_id, c.customer_name, totals.max_amount
FROM sales.customers c
LEFT JOIN (
  SELECT o.customer_id, MAX(o.amount) AS max_amount
  FROM sales.orders o
  GROUP BY o.customer_id
) totals ON totals.customer_id = c.customer_id
WHERE EXISTS (
  SELECT 1
  FROM sales.orders recent_order
  JOIN sales.order_items recent_item ON recent_item.order_id = recent_order.order_id
  WHERE recent_order.customer_id = c.customer_id
    AND recent_item.quantity > 0
)`,
  },
  {
    name: 'three-way join with qualified filters and projection aliases',
    sql: `SELECT o.order_id AS id,
       c.customer_name AS customer,
       g.region_name AS region,
       o.amount AS gross_amount
FROM sales.orders AS o
INNER JOIN sales.customers AS c ON c.customer_id = o.customer_id
LEFT JOIN sales.regions AS g ON g.region_id = c.region_id
WHERE o.amount > 0 AND c.customer_name IS NOT NULL`,
  },
  {
    name: 'compatible UNION branches sourced from different schema files',
    sql: `SELECT o.order_id AS object_id, o.status AS label
FROM sales.orders o
UNION ALL
SELECT c.customer_id AS object_id, c.customer_name AS label
FROM sales.customers c`,
  },
] as const;

const invalidQueries: readonly SemanticCase[] = [
  {
    name: 'unknown column buried in a three-way JOIN predicate',
    sql: `SELECT o.order_id, c.customer_name, g.region_name
FROM sales.orders o
JOIN sales.customers c ON c.customer_id = o.missing_customer_id
LEFT JOIN sales.regions g ON g.region_id = c.region_id`,
    expectedCode: 'unknown-column',
  },
  {
    name: 'unknown projected field from an aggregate CTE',
    sql: `WITH totals AS (
  SELECT o.customer_id, SUM(o.amount) AS total_amount
  FROM sales.orders o
  GROUP BY o.customer_id
)
SELECT totals.missing_total FROM totals`,
    expectedCode: 'unknown-column',
  },
  {
    name: 'ambiguous unqualified field after a join',
    sql: `SELECT customer_id
FROM sales.orders o
JOIN sales.customers c ON c.customer_id = o.customer_id`,
    expectedCode: 'ambiguous-column',
  },
  {
    name: 'unknown field in a USING join',
    sql: `SELECT o.order_id
FROM sales.orders o
JOIN sales.order_items i USING (missing_join_key)`,
    expectedCode: 'unknown-column',
  },
  {
    name: 'unknown qualifier used with a wildcard projection',
    sql: 'SELECT ghost.* FROM sales.orders o',
    expectedCode: 'unknown-qualifier',
  },
  {
    name: 'unknown INSERT target column with an otherwise matching shape',
    sql: `INSERT INTO sales.orders (order_id, made_up_column)
SELECT order_id, amount FROM sales.orders`,
    expectedCode: 'unknown-column',
  },
  {
    name: 'unknown field in a nested CASE expression',
    sql: `SELECT CASE WHEN o.missing_amount > 0 THEN c.customer_name ELSE g.region_name END
FROM sales.orders o
JOIN sales.customers c ON c.customer_id = o.customer_id
LEFT JOIN sales.regions g ON g.region_id = c.region_id`,
    expectedCode: 'unknown-column',
  },
  {
    name: 'unknown function wrapped around a known joined column',
    sql: `SELECT definitely_not_builtin(o.amount)
FROM sales.orders o
JOIN sales.customers c ON c.customer_id = o.customer_id`,
    expectedCode: 'unknown-function',
  },
  {
    name: 'unknown correlated field inside an EXISTS subquery',
    sql: `SELECT c.customer_id
FROM sales.customers c
WHERE EXISTS (
  SELECT 1
  FROM sales.orders o
  JOIN sales.order_items i ON i.order_id = o.order_id
  WHERE o.customer_id = c.customer_id AND i.missing_quantity > 0
)`,
    expectedCode: 'unknown-column',
  },
  {
    name: 'mismatched UNION column counts',
    sql: `SELECT o.order_id, o.amount FROM sales.orders o
UNION ALL
SELECT c.customer_id FROM sales.customers c`,
    expectedCode: 'union-column-count',
  },
  {
    name: 'incompatible UNION column types',
    sql: `SELECT o.amount FROM sales.orders o
UNION ALL
SELECT c.customer_name FROM sales.customers c`,
    expectedCode: 'incompatible-type',
  },
];

describe.each(SQL_DIALECTS)('%s adversarial schema validation', (dialect) => {
  const fixture = dialectFixtures[dialect];
  const parsedDdl = fixture.ddl.map((ddl, index) => parseDdlSchema(ddl, dialect, `${dialect}-${index}.sql`));
  const schema = createSchemaSnapshot(parsedDdl);

  it('extracts every table from separate DDL files without DDL diagnostics', () => {
    expect({
      issues: schema.issues.map((issue) => `${issue.code}: ${issue.message}`),
      tables: schema.tables.map((table) => table.normalizedName).sort(),
    }).toEqual({
      issues: [],
      tables: [
        'sales.customers',
        'sales.event_batches',
        'sales.order_items',
        'sales.orders',
        'sales.regions',
      ],
    });
  });

  it.each(validQueries)('accepts valid $name', ({ sql }) => {
    expectValidationResult(sql, dialect, schema, []);
  });

  it('accepts its dialect-specific row expansion', () => {
    expectValidationResult(fixture.expansionQuery, dialect, schema, []);
  });

  it.each(invalidQueries)('reports $expectedCode for $name', ({ sql, expectedCode }) => {
    expectValidationResult(sql, dialect, schema, [expectedCode]);
  });

  it('reports an unknown expansion output field', () => {
    expectValidationResult(fixture.invalidExpansionQuery, dialect, schema, ['unknown-column']);
  });

  it('resolves a chain of views whose dependencies are declared in later files', () => {
    const totals = parseDdlSchema(
      `CREATE VIEW sales.customer_totals AS
       SELECT o.customer_id AS customer_id, SUM(o.amount) AS total_amount
       FROM sales.orders o
       GROUP BY o.customer_id;`,
      dialect,
      `${dialect}-20-customer-totals.sql`,
    );
    const enriched = parseDdlSchema(
      `CREATE VIEW sales.enriched_customers AS
       SELECT c.customer_id AS customer_id,
              c.customer_name AS customer_name,
              r.region_name AS region_name,
              t.total_amount AS total_amount
       FROM sales.customers c
       LEFT JOIN sales.regions r ON r.region_id = c.region_id
       LEFT JOIN sales.customer_totals t ON t.customer_id = c.customer_id;`,
      dialect,
      `${dialect}-10-enriched-customers.sql`,
    );
    const crossFileSnapshot = createSchemaSnapshot([
      enriched,
      totals,
      ...parsedDdl.slice().reverse(),
    ]);

    expect({
      issues: crossFileSnapshot.issues.map((issue) => `${issue.code}: ${issue.message}`),
      columns: crossFileSnapshot.tables.find((table) => (
        table.normalizedName === 'sales.enriched_customers'
      ))?.columns.map((column) => column.normalizedName),
    }).toEqual({
      issues: [],
      columns: ['customer_id', 'customer_name', 'region_name', 'total_amount'],
    });
  });

  it('reports every duplicate table definition contributed by separate files', () => {
    const first = parseDdlSchema(fixture.ddl[0]!, dialect, `${dialect}-duplicate-a.sql`);
    const second = parseDdlSchema(fixture.ddl[0]!, dialect, `${dialect}-duplicate-b.sql`);
    const duplicateSnapshot = createSchemaSnapshot([first, second]);

    expect({
      duplicateIssues: duplicateSnapshot.issues.filter((issue) => (
        issue.code === 'duplicate-schema-table'
      )).map((issue) => issue.source).sort(),
      indexed: duplicateSnapshot.tables.some((table) => table.normalizedName === 'sales.orders'),
    }).toEqual({
      duplicateIssues: [`${dialect}-duplicate-a.sql`, `${dialect}-duplicate-b.sql`],
      indexed: false,
    });
  });

  it('rejects duplicate column names inside one CREATE TABLE', () => {
    const types = scalarTypes[dialect];
    const suffix = dialect === 'flink' ? " WITH ('connector'='values')" : '';
    const parsed = parseDdlSchema(
      `CREATE TABLE duplicate_columns (id BIGINT, id ${types.text})${suffix};`,
      dialect,
      `${dialect}-duplicate-columns.sql`,
    );

    expect({
      indexedColumns: parsed.tables[0]?.columns.map((column) => column.normalizedName),
      issueCodes: parsed.issues.map((issue) => issue.code),
    }).toEqual({
      indexedColumns: undefined,
      issueCodes: ['duplicate-schema-column'],
    });
  });

  it('reports repeated local CREATE TABLE statements', () => {
    const types = scalarTypes[dialect];
    const suffix = dialect === 'flink' ? " WITH ('connector'='values')" : '';
    const sql = `CREATE TABLE local_duplicate (id BIGINT, label ${types.text})${suffix};
CREATE TABLE local_duplicate (id BIGINT, label ${types.text})${suffix};`;
    expectValidationResult(sql, dialect, { tables: [], issues: [] }, ['duplicate-local-object']);
  });
});

function expectValidationResult(
  sql: string,
  dialect: SqlDialect,
  schema: SchemaSnapshot,
  expectedCodes: readonly string[],
): void {
  const syntax = analyzeSql(sql, dialect, []).issues.map((issue) => issue.message);
  const semanticIssues = analyzeSqlSemantics(sql, dialect, [], schema, []);
  const actualCodes = semanticIssues.map((issue) => issue.code);
  expect({
    syntax,
    missingCodes: expectedCodes.filter((code) => !actualCodes.includes(code)),
    unexpectedCodes: expectedCodes.length === 0 ? actualCodes : [],
  }).toEqual({
    syntax: [],
    missingCodes: [],
    unexpectedCodes: [],
  });
}
