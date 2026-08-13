import { describe, expect, it } from 'vitest';

import { analyzeSql, type SqlDialect } from '../../src/sql';
import { analyzeSqlSemantics, createSchemaSnapshot, parseDdlSchema } from '../../src/sqlSchemaCore';

interface AdversarialCase {
  dialect: SqlDialect;
  name: string;
  ddl: string | readonly string[];
  sql: string;
}

const cases: AdversarialCase[] = [
  {
    dialect: 'spark',
    name: 'reported reproduction',
    ddl: '',
    sql: `CREATE TABLE IF NOT EXISTS test_complex_sql (id BIGINT, json_data STRING) USING PARQUET;

SELECT t.id, pe.pos, pe.item_value,
transform(filter(t.parsed.scores, x -> x >= 0), x -> x + 1) AS adjusted_scores,
aggregate(filter(t.parsed.scores, x -> x IS NOT NULL), 0, (acc, x) -> acc + x) AS score_sum,
struct(t.parsed.name AS name, pe.pos AS item_pos, pe.item_value AS item_value) AS result_struct
FROM (
  SELECT id, from_json(json_data, 'STRUCT<name: STRING, items: ARRAY<INT>, scores: ARRAY<INT>>') AS parsed
  FROM test_complex_sql
) t
LATERAL VIEW posexplode(transform(filter(t.parsed.items, x -> x IS NOT NULL), x -> x * 2)) pe AS pos, item_value;`,
  },
  {
    dialect: 'spark',
    name: 'base table qualified struct field',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<name:STRING,address:STRUCT<city:STRING>>, events ARRAY<STRUCT<sku:STRING,price:DECIMAL(10,2)>>, attrs MAP<STRING,STRUCT<enabled:BOOLEAN>>) USING PARQUET;',
    sql: 'SELECT e.profile.name, e.profile.address.city FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'derived from_json field chain',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload STRING) USING PARQUET;',
    sql: `SELECT d.decoded.customer.id, d.decoded.customer.address.city
FROM (SELECT from_json(payload, 'STRUCT<customer:STRUCT<id:BIGINT,address:STRUCT<city:STRING>>>') decoded FROM raw_events) d`,
  },
  {
    dialect: 'spark',
    name: 'CTE from_json field and lambdas',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload STRING) USING PARQUET;',
    sql: `WITH decoded AS (
  SELECT id, from_json(payload, 'STRUCT<items:ARRAY<STRUCT<sku:STRING,price:DOUBLE>>,scores:ARRAY<INT>>') event FROM raw_events
)
SELECT d.event.items, transform(d.event.items, x -> x.sku), aggregate(d.event.scores, 0, (a, x) -> a + x)
FROM decoded d`,
  },
  {
    dialect: 'spark',
    name: 'qualified array subscript struct field',
    ddl: 'CREATE TABLE nested_events (id BIGINT, events ARRAY<STRUCT<sku:STRING,price:DOUBLE>>) USING PARQUET;',
    sql: 'SELECT e.events[0].sku, element_at(e.events, 1).price FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'qualified map lookup struct field',
    ddl: 'CREATE TABLE nested_events (id BIGINT, attrs MAP<STRING,STRUCT<enabled:BOOLEAN,label:STRING>>) USING PARQUET;',
    sql: "SELECT e.attrs['primary'].enabled, element_at(e.attrs, 'primary').label FROM nested_events e",
  },
  {
    dialect: 'spark',
    name: 'nested lambda shadowing',
    ddl: 'CREATE TABLE nested_events (matrix ARRAY<ARRAY<INT>>) USING PARQUET;',
    sql: 'SELECT transform(e.matrix, row_values -> filter(row_values, cell -> cell > 0)) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'zip_with lambda parameters',
    ddl: 'CREATE TABLE nested_events (left_values ARRAY<INT>, right_values ARRAY<INT>) USING PARQUET;',
    sql: 'SELECT zip_with(e.left_values, e.right_values, (left_value, right_value) -> left_value + right_value) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'map_zip_with lambda parameters',
    ddl: 'CREATE TABLE nested_events (left_map MAP<STRING,INT>, right_map MAP<STRING,INT>) USING PARQUET;',
    sql: 'SELECT map_zip_with(e.left_map, e.right_map, (key, left_value, right_value) -> coalesce(left_value, 0) + coalesce(right_value, 0)) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'transform_keys and transform_values lambdas',
    ddl: 'CREATE TABLE nested_events (attrs MAP<STRING,INT>) USING PARQUET;',
    sql: "SELECT transform_keys(e.attrs, (key, value) -> upper(key)), transform_values(e.attrs, (key, value) -> value + 1) FROM nested_events e",
  },
  {
    dialect: 'spark',
    name: 'exists and forall lambdas',
    ddl: 'CREATE TABLE nested_events (scores ARRAY<INT>) USING PARQUET;',
    sql: 'SELECT exists(e.scores, score -> score > 10), forall(e.scores, score -> score IS NOT NULL) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'lateral posexplode qualified nested input',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<items:ARRAY<STRUCT<sku:STRING,price:DOUBLE>>>) USING PARQUET;',
    sql: 'SELECT e.id, item.sku, item.price FROM nested_events e LATERAL VIEW posexplode(e.profile.items) lv AS pos, item',
  },
  {
    dialect: 'spark',
    name: 'nested structs through cross file view',
    ddl: [
      "CREATE VIEW decoded_events AS SELECT id, from_json(payload, 'STRUCT<customer:STRUCT<id:BIGINT,name:STRING>>') AS decoded FROM raw_events;",
      'CREATE TABLE raw_events (id BIGINT, payload STRING) USING PARQUET;',
    ],
    sql: 'SELECT v.decoded.customer.id, v.decoded.customer.name FROM decoded_events v',
  },
  {
    dialect: 'spark',
    name: 'qualified named_struct through derived table',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload STRING) USING PARQUET;',
    sql: "SELECT d.object.id, d.object.label FROM (SELECT named_struct('id', id, 'label', payload) AS object FROM raw_events) d",
  },
  {
    dialect: 'spark',
    name: 'qualified struct constructor through CTE',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload STRING) USING PARQUET;',
    sql: 'WITH shaped AS (SELECT struct(id AS id, payload AS label) AS object FROM raw_events) SELECT s.object.id, s.object.label FROM shaped s',
  },
  {
    dialect: 'hive',
    name: 'hive qualified struct fields',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<name:STRING,address:STRUCT<city:STRING>>, events ARRAY<STRUCT<sku:STRING,price:DOUBLE>>);',
    sql: 'SELECT e.profile.name, e.profile.address.city FROM nested_events e',
  },
  {
    dialect: 'hive',
    name: 'hive derived named_struct fields',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload STRING);',
    sql: "SELECT d.object.id, d.object.label FROM (SELECT named_struct('id', id, 'label', payload) object FROM raw_events) d",
  },
  {
    dialect: 'hive',
    name: 'hive nested lateral view input',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<items:ARRAY<STRUCT<sku:STRING,price:DOUBLE>>>);',
    sql: 'SELECT e.id, item.sku FROM nested_events e LATERAL VIEW explode(e.profile.items) lv AS item',
  },
  {
    dialect: 'trino',
    name: 'trino qualified row fields',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile ROW(name VARCHAR, address ROW(city VARCHAR)), events ARRAY(ROW(sku VARCHAR, price DOUBLE)));',
    sql: 'SELECT e.profile.name, e.profile.address.city FROM nested_events e',
  },
  {
    dialect: 'trino',
    name: 'trino qualified row fields through CTE',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile ROW(name VARCHAR, scores ARRAY(INTEGER)));',
    sql: 'WITH shaped AS (SELECT profile FROM nested_events) SELECT s.profile.name, transform(s.profile.scores, x -> x + 1) FROM shaped s',
  },
  {
    dialect: 'trino',
    name: 'trino nested unnest input',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile ROW(items ARRAY(ROW(sku VARCHAR, price DOUBLE))));',
    sql: 'SELECT e.id, item.sku FROM nested_events e CROSS JOIN UNNEST(e.profile.items) AS u(item)',
  },
  {
    dialect: 'flink',
    name: 'flink qualified row fields',
    ddl: "CREATE TABLE nested_events (id BIGINT, profile ROW<name STRING, address ROW<city STRING>>, events ARRAY<ROW<sku STRING, price DOUBLE>>) WITH ('connector'='values');",
    sql: 'SELECT e.profile.name, e.profile.address.city FROM nested_events e',
  },
  {
    dialect: 'flink',
    name: 'flink nested unnest input',
    ddl: "CREATE TABLE nested_events (id BIGINT, profile ROW<items ARRAY<ROW<sku STRING, price DOUBLE>>>) WITH ('connector'='values');",
    sql: 'SELECT e.id, item.sku FROM nested_events e CROSS JOIN UNNEST(e.profile.items) AS u(item)',
  },
  {
    dialect: 'impala',
    name: 'impala qualified struct fields',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<name:STRING,address:STRUCT<city:STRING>>, events ARRAY<STRUCT<sku:STRING,price:DOUBLE>>);',
    sql: 'SELECT e.profile.name, e.profile.address.city FROM nested_events e',
  },
  {
    dialect: 'impala',
    name: 'impala nested collection relation',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<items:ARRAY<STRUCT<sku:STRING,price:DOUBLE>>>);',
    sql: 'SELECT e.id, item.item.sku FROM nested_events e, e.profile.items item',
  },
  {
    dialect: 'generic',
    name: 'generic qualified struct fields',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<name:VARCHAR,address:STRUCT<city:VARCHAR>>, events ARRAY<STRUCT<sku:VARCHAR,price:DOUBLE>>);',
    sql: 'SELECT e.profile.name, e.profile.address.city FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'missing qualified struct field should be a column error',
    ddl: 'CREATE TABLE nested_events (id BIGINT, profile STRUCT<name:STRING,address:STRUCT<city:STRING>>) USING PARQUET;',
    sql: 'SELECT e.profile.missing, e.profile.address.missing_city FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'missing struct field after array subscript',
    ddl: 'CREATE TABLE nested_events (events ARRAY<STRUCT<sku:STRING,price:DOUBLE>>) USING PARQUET;',
    sql: 'SELECT e.events[0].missing FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'missing struct field after map lookup',
    ddl: 'CREATE TABLE nested_events (attrs MAP<STRING,STRUCT<enabled:BOOLEAN,label:STRING>>) USING PARQUET;',
    sql: "SELECT element_at(e.attrs, 'primary').missing FROM nested_events e",
  },
  {
    dialect: 'spark',
    name: 'missing lambda struct field',
    ddl: 'CREATE TABLE nested_events (events ARRAY<STRUCT<sku:STRING,price:DOUBLE>>) USING PARQUET;',
    sql: 'SELECT transform(e.events, item -> item.missing) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'missing aggregate lambda struct field',
    ddl: 'CREATE TABLE nested_events (events ARRAY<STRUCT<sku:STRING,price:DOUBLE>>) USING PARQUET;',
    sql: 'SELECT aggregate(e.events, 0D, (total, item) -> total + item.missing) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'insert case string into bigint',
    ddl: 'CREATE TABLE source_values (id BIGINT) USING PARQUET; CREATE TABLE numeric_target (value BIGINT) USING PARQUET;',
    sql: "INSERT INTO numeric_target SELECT CASE WHEN id > 0 THEN 'positive' ELSE 'negative' END FROM source_values",
  },
  {
    dialect: 'spark',
    name: 'insert lower string into bigint',
    ddl: 'CREATE TABLE source_values (label STRING) USING PARQUET; CREATE TABLE numeric_target (value BIGINT) USING PARQUET;',
    sql: 'INSERT INTO numeric_target SELECT lower(label) FROM source_values',
  },
  {
    dialect: 'spark',
    name: 'insert incompatible array element type',
    ddl: 'CREATE TABLE source_values (labels ARRAY<STRING>) USING PARQUET; CREATE TABLE numeric_target (payload_array ARRAY<INT>) USING PARQUET;',
    sql: 'INSERT INTO numeric_target SELECT labels FROM source_values',
  },
  {
    dialect: 'spark',
    name: 'insert incompatible map value type',
    ddl: 'CREATE TABLE source_values (attrs MAP<STRING,STRING>) USING PARQUET; CREATE TABLE numeric_target (attrs MAP<STRING,INT>) USING PARQUET;',
    sql: 'INSERT INTO numeric_target SELECT attrs FROM source_values',
  },
  {
    dialect: 'spark',
    name: 'insert incompatible struct field type',
    ddl: 'CREATE TABLE source_values (payload STRUCT<id:STRING>) USING PARQUET; CREATE TABLE numeric_target (payload STRUCT<id:BIGINT>) USING PARQUET;',
    sql: 'INSERT INTO numeric_target SELECT payload FROM source_values',
  },
  {
    dialect: 'spark',
    name: 'union incompatible array element type',
    ddl: 'CREATE TABLE string_values (payload_array ARRAY<STRING>) USING PARQUET; CREATE TABLE numeric_values (payload_array ARRAY<INT>) USING PARQUET;',
    sql: 'SELECT payload_array FROM string_values UNION ALL SELECT payload_array FROM numeric_values',
  },
  {
    dialect: 'spark',
    name: 'union case string with bigint',
    ddl: 'CREATE TABLE source_values (id BIGINT) USING PARQUET;',
    sql: "SELECT CASE WHEN id > 0 THEN 'yes' ELSE 'no' END FROM source_values UNION ALL SELECT id FROM source_values",
  },
  {
    dialect: 'spark',
    name: 'update case string into bigint',
    ddl: 'CREATE TABLE source_values (id BIGINT, label STRING) USING PARQUET;',
    sql: "UPDATE source_values SET id = CASE WHEN label IS NULL THEN '0' ELSE label END",
  },
  {
    dialect: 'spark',
    name: 'duplicate CTE names',
    ddl: 'CREATE TABLE source_values (id BIGINT) USING PARQUET;',
    sql: 'WITH duplicate_name AS (SELECT id FROM source_values), duplicate_name AS (SELECT id FROM source_values) SELECT id FROM duplicate_name',
  },
  {
    dialect: 'spark',
    name: 'non lateral derived table correlation',
    ddl: 'CREATE TABLE source_values (id BIGINT) USING PARQUET;',
    sql: 'SELECT outer_table.id FROM source_values outer_table JOIN (SELECT outer_table.id AS copied_id) inner_table ON inner_table.copied_id = outer_table.id',
  },
  {
    dialect: 'mysql',
    name: 'mysql nested JSON_TABLE columns',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload JSON);',
    sql: `SELECT e.id, jt.order_id, jt.item_sku, jt.item_no
FROM raw_events e
JOIN JSON_TABLE(e.payload, '$.orders[*]' COLUMNS(
  order_id BIGINT PATH '$.id',
  NESTED PATH '$.items[*]' COLUMNS(
    item_sku VARCHAR(100) PATH '$.sku',
    item_no FOR ORDINALITY
  )
)) jt ON TRUE`,
  },
  {
    dialect: 'mysql',
    name: 'mysql JSON_TABLE exists column',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload JSON);',
    sql: `SELECT jt.item_name, jt.has_weight
FROM raw_events e
JOIN JSON_TABLE(e.payload, '$.items[*]' COLUMNS(
  item_name VARCHAR(100) PATH '$.name',
  has_weight INT EXISTS PATH '$.weight'
)) jt ON TRUE`,
  },
  {
    dialect: 'mysql',
    name: 'mysql JSON_TABLE through CTE',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload JSON);',
    sql: `WITH expanded AS (
  SELECT e.id, jt.item_name
  FROM raw_events e
  JOIN JSON_TABLE(e.payload, '$.items[*]' COLUMNS(item_name VARCHAR(100) PATH '$.name')) jt ON TRUE
)
SELECT x.id, x.item_name FROM expanded x`,
  },
  {
    dialect: 'postgresql',
    name: 'postgres jsonb_to_record typed outputs',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload JSONB);',
    sql: `SELECT e.id, decoded.name, decoded.score
FROM raw_events e
CROSS JOIN LATERAL jsonb_to_record(e.payload) AS decoded(name TEXT, score INTEGER)`,
  },
  {
    dialect: 'postgresql',
    name: 'postgres jsonb_to_recordset typed outputs',
    ddl: 'CREATE TABLE raw_events (id BIGINT, payload JSONB);',
    sql: `SELECT e.id, item.sku, item.quantity
FROM raw_events e
CROSS JOIN LATERAL jsonb_to_recordset(e.payload -> 'items') AS item(sku TEXT, quantity INTEGER)`,
  },
  {
    dialect: 'postgresql',
    name: 'postgres multi argument unnest outputs',
    ddl: 'CREATE TABLE raw_events (id BIGINT, labels TEXT[], scores INTEGER[]);',
    sql: 'SELECT e.id, expanded.label, expanded.score FROM raw_events e CROSS JOIN LATERAL unnest(e.labels, e.scores) AS expanded(label, score)',
  },
  {
    dialect: 'postgresql',
    name: 'postgres unnest with ordinality outputs',
    ddl: 'CREATE TABLE raw_events (id BIGINT, labels TEXT[]);',
    sql: 'SELECT e.id, expanded.label, expanded.position FROM raw_events e CROSS JOIN LATERAL unnest(e.labels) WITH ORDINALITY AS expanded(label, position)',
  },
  {
    dialect: 'trino',
    name: 'trino missing lambda row field',
    ddl: 'CREATE TABLE nested_events (events ARRAY(ROW(sku VARCHAR, price DOUBLE)));',
    sql: 'SELECT transform(events, item -> item.missing) FROM nested_events',
  },
  {
    dialect: 'trino',
    name: 'trino incompatible array insert',
    ddl: 'CREATE TABLE string_values (payload_array ARRAY(VARCHAR)); CREATE TABLE numeric_target (payload_array ARRAY(INTEGER));',
    sql: 'INSERT INTO numeric_target SELECT payload_array FROM string_values',
  },
  {
    dialect: 'flink',
    name: 'flink incompatible row field insert',
    ddl: "CREATE TABLE string_values (payload ROW<id STRING>) WITH ('connector'='values'); CREATE TABLE numeric_target (payload ROW<id BIGINT>) WITH ('connector'='values');",
    sql: 'INSERT INTO numeric_target SELECT payload FROM string_values',
  },
  {
    dialect: 'generic',
    name: 'generic incompatible array union',
    ddl: 'CREATE TABLE string_values (payload_array ARRAY<VARCHAR>); CREATE TABLE numeric_values (payload_array ARRAY<INTEGER>);',
    sql: 'SELECT payload_array FROM string_values UNION ALL SELECT payload_array FROM numeric_values',
  },
  {
    dialect: 'spark',
    name: 'map_filter builtin',
    ddl: 'CREATE TABLE nested_events (attrs MAP<STRING,INT>) USING PARQUET;',
    sql: 'SELECT map_filter(e.attrs, (key, value) -> value > 0) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'array_sort comparator builtin',
    ddl: 'CREATE TABLE nested_events (scores ARRAY<INT>) USING PARQUET;',
    sql: 'SELECT array_sort(e.scores, (left_value, right_value) -> CASE WHEN left_value < right_value THEN -1 WHEN left_value > right_value THEN 1 ELSE 0 END) FROM nested_events e',
  },
  {
    dialect: 'spark',
    name: 'union branch alias leakage',
    ddl: 'CREATE TABLE left_values (id BIGINT) USING PARQUET; CREATE TABLE right_values (id BIGINT) USING PARQUET;',
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
  {
    dialect: 'spark',
    name: 'qualified complex union type mismatch',
    ddl: 'CREATE TABLE string_values (payload_array ARRAY<STRING>) USING PARQUET; CREATE TABLE numeric_values (payload_array ARRAY<INT>) USING PARQUET;',
    sql: 'SELECT s.payload_array FROM string_values s UNION ALL SELECT n.payload_array FROM numeric_values n',
  },
  {
    dialect: 'hive',
    name: 'hive missing qualified struct field',
    ddl: 'CREATE TABLE nested_events (profile STRUCT<name:STRING,address:STRUCT<city:STRING>>);',
    sql: 'SELECT e.profile.missing, e.profile.address.missing_city FROM nested_events e',
  },
  {
    dialect: 'hive',
    name: 'hive complex insert type mismatch',
    ddl: 'CREATE TABLE string_values (payload STRUCT<id:STRING>); CREATE TABLE numeric_target (payload STRUCT<id:BIGINT>);',
    sql: 'INSERT INTO numeric_target SELECT payload FROM string_values',
  },
  {
    dialect: 'hive',
    name: 'hive union branch alias leakage',
    ddl: 'CREATE TABLE left_values (id BIGINT); CREATE TABLE right_values (id BIGINT);',
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
  {
    dialect: 'flink',
    name: 'flink missing qualified row field',
    ddl: "CREATE TABLE nested_events (profile ROW<name STRING,address ROW<city STRING>>) WITH ('connector'='values');",
    sql: 'SELECT e.profile.missing, e.profile.address.missing_city FROM nested_events e',
  },
  {
    dialect: 'flink',
    name: 'flink complex array insert mismatch',
    ddl: "CREATE TABLE string_values (payload_array ARRAY<STRING>) WITH ('connector'='values'); CREATE TABLE numeric_target (payload_array ARRAY<INT>) WITH ('connector'='values');",
    sql: 'INSERT INTO numeric_target SELECT payload_array FROM string_values',
  },
  {
    dialect: 'flink',
    name: 'flink union branch alias leakage',
    ddl: "CREATE TABLE left_values (id BIGINT) WITH ('connector'='values'); CREATE TABLE right_values (id BIGINT) WITH ('connector'='values');",
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
  {
    dialect: 'mysql',
    name: 'mysql JSON_TABLE type mismatch insert',
    ddl: 'CREATE TABLE raw_events (payload JSON); CREATE TABLE numeric_target (value BIGINT);',
    sql: `INSERT INTO numeric_target
SELECT jt.label FROM raw_events e
JOIN JSON_TABLE(e.payload, '$' COLUMNS(label VARCHAR(100) PATH '$.label')) jt ON TRUE`,
  },
  {
    dialect: 'mysql',
    name: 'mysql nested JSON_TABLE type mismatch insert',
    ddl: 'CREATE TABLE raw_events (payload JSON); CREATE TABLE numeric_target (value BIGINT);',
    sql: `INSERT INTO numeric_target
SELECT jt.item_sku FROM raw_events e
JOIN JSON_TABLE(e.payload, '$.items[*]' COLUMNS(
  NESTED PATH '$' COLUMNS(item_sku VARCHAR(100) PATH '$.sku')
)) jt ON TRUE`,
  },
  {
    dialect: 'mysql',
    name: 'mysql union branch alias leakage',
    ddl: 'CREATE TABLE left_values (id BIGINT); CREATE TABLE right_values (id BIGINT);',
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
  {
    dialect: 'postgresql',
    name: 'postgres record output type mismatch insert',
    ddl: 'CREATE TABLE raw_events (payload JSONB); CREATE TABLE numeric_target (value BIGINT);',
    sql: `INSERT INTO numeric_target
SELECT decoded.label FROM raw_events e
CROSS JOIN LATERAL jsonb_to_record(e.payload) AS decoded(label TEXT)`,
  },
  {
    dialect: 'postgresql',
    name: 'postgres unnest output type mismatch insert',
    ddl: 'CREATE TABLE raw_events (labels TEXT[]); CREATE TABLE numeric_target (value BIGINT);',
    sql: `INSERT INTO numeric_target
SELECT expanded.label FROM raw_events e
CROSS JOIN LATERAL unnest(e.labels) AS expanded(label)`,
  },
  {
    dialect: 'postgresql',
    name: 'postgres union branch alias leakage',
    ddl: 'CREATE TABLE left_values (id BIGINT); CREATE TABLE right_values (id BIGINT);',
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
  {
    dialect: 'trino',
    name: 'trino missing qualified row field',
    ddl: 'CREATE TABLE nested_events (profile ROW(name VARCHAR,address ROW(city VARCHAR)));',
    sql: 'SELECT e.profile.missing, e.profile.address.missing_city FROM nested_events e',
  },
  {
    dialect: 'trino',
    name: 'trino unnest with ordinality',
    ddl: 'CREATE TABLE nested_events (id BIGINT, labels ARRAY(VARCHAR));',
    sql: 'SELECT e.id, u.label, u.position FROM nested_events e CROSS JOIN UNNEST(e.labels) WITH ORDINALITY AS u(label, position)',
  },
  {
    dialect: 'trino',
    name: 'trino union branch alias leakage',
    ddl: 'CREATE TABLE left_values (id BIGINT); CREATE TABLE right_values (id BIGINT);',
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
  {
    dialect: 'impala',
    name: 'impala map collection relation',
    ddl: 'CREATE TABLE nested_events (id BIGINT, attrs MAP<STRING,STRUCT<enabled:BOOLEAN,label:STRING>>);',
    sql: 'SELECT e.id, entry.key, entry.value.enabled FROM nested_events e, e.attrs entry',
  },
  {
    dialect: 'impala',
    name: 'impala missing nested collection field',
    ddl: 'CREATE TABLE nested_events (id BIGINT, events ARRAY<STRUCT<sku:STRING,price:DOUBLE>>);',
    sql: 'SELECT item.item.missing FROM nested_events e, e.events item',
  },
  {
    dialect: 'impala',
    name: 'impala union branch alias leakage',
    ddl: 'CREATE TABLE left_values (id BIGINT); CREATE TABLE right_values (id BIGINT);',
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
  {
    dialect: 'generic',
    name: 'generic missing qualified struct field',
    ddl: 'CREATE TABLE nested_events (profile STRUCT<name:VARCHAR,address:STRUCT<city:VARCHAR>>);',
    sql: 'SELECT e.profile.missing, e.profile.address.missing_city FROM nested_events e',
  },
  {
    dialect: 'generic',
    name: 'generic complex insert mismatch',
    ddl: 'CREATE TABLE string_values (payload STRUCT<id:VARCHAR>); CREATE TABLE numeric_target (payload STRUCT<id:BIGINT>);',
    sql: 'INSERT INTO numeric_target SELECT payload FROM string_values',
  },
  {
    dialect: 'generic',
    name: 'generic unnest with ordinality',
    ddl: 'CREATE TABLE nested_events (id BIGINT, labels ARRAY<VARCHAR>);',
    sql: 'SELECT e.id, u.label, u.position FROM nested_events e CROSS JOIN UNNEST(e.labels) WITH ORDINALITY AS u(label, position)',
  },
  {
    dialect: 'generic',
    name: 'generic union branch alias leakage',
    ddl: 'CREATE TABLE left_values (id BIGINT); CREATE TABLE right_values (id BIGINT);',
    sql: 'SELECT right_side.id FROM left_values left_side UNION ALL SELECT right_side.id FROM right_values right_side',
  },
];

const expectedSemanticCodes: Readonly<Record<string, readonly string[]>> = {
  'missing qualified struct field should be a column error': ['unknown-column'],
  'missing struct field after array subscript': ['unknown-column'],
  'missing struct field after map lookup': ['unknown-column'],
  'missing lambda struct field': ['unknown-column'],
  'missing aggregate lambda struct field': ['unknown-column'],
  'insert case string into bigint': ['incompatible-type'],
  'insert lower string into bigint': ['incompatible-type'],
  'insert incompatible array element type': ['incompatible-type'],
  'insert incompatible map value type': ['incompatible-type'],
  'insert incompatible struct field type': ['incompatible-type'],
  'union incompatible array element type': ['incompatible-type'],
  'union case string with bigint': ['incompatible-type'],
  'update case string into bigint': ['incompatible-type'],
  'duplicate CTE names': ['duplicate-cte'],
  'non lateral derived table correlation': ['unknown-qualifier'],
  'trino missing lambda row field': ['unknown-column'],
  'trino incompatible array insert': ['incompatible-type'],
  'flink incompatible row field insert': ['incompatible-type'],
  'generic incompatible array union': ['incompatible-type'],
  'union branch alias leakage': ['unknown-qualifier'],
  'qualified complex union type mismatch': ['incompatible-type'],
  'hive missing qualified struct field': ['unknown-column'],
  'hive complex insert type mismatch': ['incompatible-type'],
  'hive union branch alias leakage': ['unknown-qualifier'],
  'flink missing qualified row field': ['unknown-column'],
  'flink complex array insert mismatch': ['incompatible-type'],
  'flink union branch alias leakage': ['unknown-qualifier'],
  'mysql JSON_TABLE type mismatch insert': ['incompatible-type'],
  'mysql nested JSON_TABLE type mismatch insert': ['incompatible-type'],
  'mysql union branch alias leakage': ['unknown-qualifier'],
  'postgres record output type mismatch insert': ['incompatible-type'],
  'postgres unnest output type mismatch insert': ['incompatible-type'],
  'postgres union branch alias leakage': ['unknown-qualifier'],
  'trino missing qualified row field': ['unknown-column'],
  'trino union branch alias leakage': ['unknown-qualifier'],
  'impala missing nested collection field': ['unknown-column'],
  'impala union branch alias leakage': ['unknown-qualifier'],
  'generic missing qualified struct field': ['unknown-column'],
  'generic complex insert mismatch': ['incompatible-type'],
  'generic union branch alias leakage': ['unknown-qualifier'],
};

// These are deliberately red acceptance tests for the next checker iteration.
// A missing key denotes legal SQL that must produce no semantic diagnostics.
describe('round two adversarial schema validation', () => {
  it.each(cases)('$dialect: $name', ({ dialect, name, ddl, sql }) => {
    const ddlFiles = typeof ddl === 'string' ? [ddl] : ddl;
    const parsed = ddlFiles.filter((text) => text.trim()).map((text, index) => (
      parseDdlSchema(text, dialect, `${dialect}-${index}-${name}.sql`)
    ));
    const snapshot = createSchemaSnapshot(parsed);
    const syntaxIssues = analyzeSql(sql, dialect, []).issues.map((issue) => issue.message);
    const semanticCodes = uniqueSorted(analyzeSqlSemantics(sql, dialect, [], snapshot, []).map((issue) => issue.code));

    expect({
      ddlCodes: uniqueSorted(snapshot.issues.map((issue) => issue.code)),
      semanticCodes,
      syntaxIssues,
    }).toEqual({
      ddlCodes: [],
      semanticCodes: [...(expectedSemanticCodes[name] ?? [])].sort(),
      syntaxIssues: [],
    });
  });
});

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
