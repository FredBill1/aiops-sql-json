import { SQL_DIALECTS, type SqlDialect } from '../../src/sql';

export type ExpectedFunctionType =
  | 'number' | 'string' | 'boolean' | 'date' | 'time' | 'binary'
  | 'array<number>' | 'array<string>' | 'array<boolean>'
  | 'map<string,number>' | 'map<string,boolean>' | 'map<string,unknown>'
  | 'map<string,array<boolean>>' | 'map<string,array<unknown>>'
  | 'struct<enabled:boolean>' | 'struct<value:unknown>'
  | 'INTERVAL' | 'JSON' | 'JSONB' | 'REGTYPE';

export interface FunctionTypeCase {
  dialect: SqlDialect;
  expression: string;
  expected: ExpectedFunctionType;
  /** A legal enclosing expression that currently produces a false diagnostic. */
  consumer?: string;
}

type TypeRow = readonly [expression: string, expected: ExpectedFunctionType, consumer?: string];

function cases(dialect: SqlDialect, rows: readonly TypeRow[]): FunctionTypeCase[] {
  return rows.map(([expression, expected, consumer]) => ({ dialect, expression, expected, consumer }));
}

// These are desired results, NOT snapshots of the current, incorrect inference.
// {value} in a consumer is replaced by the complete producer expression.
// SQL validity/return shapes were cross-checked against the official references
// listed below. No database server is required by this offline regression suite.
export const functionTypeCases: readonly FunctionTypeCase[] = [
  // https://spark.apache.org/docs/latest/api/sql/
  ...cases('spark', [
    // Boolean/NULL arguments without source positions move ahead of the array.
    ['sort_array(ints, false)', 'array<number>', 'transform({value}, x -> CAST(x AS STRING))'],
    ['sort_array(ints, true)', 'array<number>', 'filter({value}, x -> x > 0)'],
    ['array_append(bools, false)', 'array<boolean>', 'transform({value}, x -> NOT x)'],
    ['array_prepend(bools, false)', 'array<boolean>', 'transform({value}, x -> NOT x)'],
    ['array_remove(bools, false)', 'array<boolean>', 'transform({value}, x -> NOT x)'],
    ['array_insert(bools, 1, false)', 'array<boolean>', 'transform({value}, x -> NOT x)'],
    ['array_append(texts, NULL)', 'array<string>'],
    ['array_prepend(texts, NULL)', 'array<string>'],
    ['array_remove(texts, NULL)', 'array<string>'],
    ['array_insert(texts, 1, NULL)', 'array<string>'],
    ['array_except(texts, NULL)', 'array<string>'],
    ['array_intersect(texts, NULL)', 'array<string>'],
    ['array_union(texts, NULL)', 'array<string>'],
    ['array_repeat(n, NULL)', 'array<number>'],
    ['slice(ints, 1, NULL)', 'array<number>'],
    ['map(s, false)', 'map<string,boolean>'],
    ['map(s, NULL)', 'map<string,unknown>'],
    ['map_concat(pairs, NULL)', 'map<string,number>'],
    ["named_struct('enabled', false)", 'struct<enabled:boolean>'],
    ["named_struct('value', NULL)", 'struct<value:unknown>'],
    ['min_by(s, false)', 'string', 'lower({value})'],
    ['max_by(s, true)', 'string', 'lower({value})'],
    ['first(s, true)', 'string'],
    ['last(s, true)', 'string'],
    ['first_value(s, true) OVER (ORDER BY n)', 'string'],
    ['last_value(s, true) OVER (ORDER BY n)', 'string'],
    ['first_value(s, false) OVER (ORDER BY n)', 'string'],
    ['last_value(s, false) OVER (ORDER BY n)', 'string'],
    ['if(flag, s, NULL)', 'string'],
    ['if(flag, NULL, s)', 'string'],
    ['if(flag, ints, NULL)', 'array<number>'],
    ['nullif(s, NULL)', 'string'],
    // NVL2 returns a branch, not its condition. ARRAY_* need individual rules.
    ['nvl2(flag, texts, texts)', 'array<string>', 'transform({value}, x -> upper(x))'],
    ['nvl2(n, s, s)', 'string', 'lower({value})'],
    ['array_max(texts)', 'string', 'lower({value})'],
    ['array_min(texts)', 'string', 'lower({value})'],
    ['array_max(array(texts))', 'array<string>'],
    ['array_size(ints)', 'number', 'substring(s, {value}, 1)'],
    ['array_position(texts, s)', 'number', 'substring(s, {value}, 1)'],
    ["array_join(texts, ',')", 'string', 'lower({value})'],
    ['get(texts, 0)', 'string'],
    ['reverse(ints)', 'array<number>', 'transform({value}, x -> x + 1)'],
    // The omitted regexp group is a synthetic numeric AST argument.
    ["regexp_extract_all(s, '(.)')", 'array<string>', 'transform({value}, x -> upper(x))'],
    // Cross-dialect name heuristics confuse text/binary/date/number results.
    ["decode(bin, 'UTF-8')", 'string', 'lower({value})'],
    ["encode(s, 'UTF-8')", 'binary'],
    ['ascii(s)', 'number', 'substring(s, {value}, 1)'],
    ['from_unixtime(n)', 'string', 'lower({value})'],
    ["trunc(d, 'MM')", 'date'],
    ['months_between(ts, ts, false)', 'number'],
    ["to_unix_timestamp(s, 'yyyy-MM-dd')", 'number'],
    ['make_interval(1, 2, 3, 4, 5, 6, 7)', 'INTERVAL'],
    ['make_dt_interval(1, 2, 3, 4)', 'INTERVAL'],
    ['make_ym_interval(1, 2)', 'INTERVAL'],
    ["try_to_binary(s, 'hex')", 'binary'],
    ["to_number(s, '999')", 'number'],
    ["try_to_number(s, '999')", 'number'],
    ['bitmap_count(bin)', 'number'],
    ['decode(n, 1, s, s)', 'string'],
    ['to_json(pairs)', 'string', 'lower({value})'],
    ["to_json(pairs, map('pretty', 'true'))", 'string'],
    ['isnull(s)', 'boolean'],
    ['isnotnull(s)', 'boolean'],
    ['isnan(n)', 'boolean'],
    ['substring(bin, 1, 2)', 'binary'],
  ]),
  // https://hive.apache.org/docs/latest/language/languagemanual-udf/
  // https://hive.apache.org/docs/latest/language/hive-udfs/
  // https://hive.apache.org/docs/latest/language/languagemanual-windowingandanalytics/
  ...cases('hive', [
    ['array_remove(bools, false)', 'array<boolean>'],
    ["array_join(texts, ',', ':')", 'string'],
    ['map(s, false)', 'map<string,boolean>'],
    ['map(s, NULL)', 'map<string,unknown>'],
    ["named_struct('enabled', false)", 'struct<enabled:boolean>'],
    ["named_struct('value', NULL)", 'struct<value:unknown>'],
    ['if(flag, s, NULL)', 'string'],
    ['if(flag, NULL, s)', 'string'],
    ['nullif(s, NULL)', 'string'],
    ['first_value(s, true) OVER (ORDER BY n)', 'string'],
    ['last_value(s, true) OVER (ORDER BY n)', 'string'],
    ['first_value(s, false) OVER (ORDER BY n)', 'string'],
    ['last_value(s, false) OVER (ORDER BY n)', 'string'],
    ["decode(bin, 'UTF-8')", 'string', 'lower({value})'],
    ["encode(s, 'UTF-8')", 'binary'],
    ['ascii(s)', 'number', 'substring(s, {value}, 1)'],
    ['from_unixtime(n)', 'string', 'lower({value})'],
    ['months_between(ts, ts)', 'number'],
    ["trunc(d, 'MM')", 'string', 'lower({value})'],
    ['last_day(d)', 'string', 'lower({value})'],
    ["next_day(d, 'MON')", 'string', 'lower({value})'],
    ['add_months(d, 1)', 'string'],
    ['isnull(s)', 'boolean'],
    ['isnotnull(s)', 'boolean'],
  ]),
  // https://nightlies.apache.org/flink/flink-docs-release-2.3/docs/sql/functions/built-in-functions/
  ...cases('flink', [
    ['MAP[s, false]', 'map<string,boolean>'],
    ['MAP[s, NULL]', 'map<string,unknown>'],
    ['array_append(bools, false)', 'array<boolean>', 'array_sort({value})'],
    ['array_prepend(bools, false)', 'array<boolean>', 'array_sort({value})'],
    ['array_remove(bools, false)', 'array<boolean>', 'array_sort({value})'],
    ['array_append(texts, NULL)', 'array<string>'],
    ['array_prepend(texts, NULL)', 'array<string>'],
    ['array_remove(texts, NULL)', 'array<string>'],
    ['array_concat(texts, NULL)', 'array<string>'],
    ['array_union(texts, NULL)', 'array<string>'],
    ['array_except(texts, NULL)', 'array<string>'],
    ['array_intersect(texts, NULL)', 'array<string>'],
    ['array_max(texts)', 'string', 'lower({value})'],
    ['array_min(texts)', 'string', 'lower({value})'],
    ['array_position(texts, s)', 'number', 'substring(s, {value}, 1)'],
    ["array_join(texts, ',')", 'string', 'lower({value})'],
    ["element(ARRAY['only'])", 'string', 'lower({value})'],
    ["regexp_extract_all(s, '(.)')", 'array<string>'],
    ['if(flag, s, NULL)', 'string'],
    ['if(flag, NULL, s)', 'string'],
    ['nullif(s, NULL)', 'string'],
    ["decode(bin, 'UTF-8')", 'string', 'lower({value})'],
    ["encode(s, 'UTF-8')", 'binary'],
    ['ascii(s)', 'number', 'substring(s, {value}, 1)'],
    ['from_unixtime(n)', 'string', 'lower({value})'],
    ['json_array(n)', 'string', 'lower({value})'],
    ["json_object('a' VALUE n)", 'string'],
  ]),
  // https://www.postgresql.org/docs/current/functions-array.html
  // https://www.postgresql.org/docs/current/functions-string.html
  // https://www.postgresql.org/docs/current/functions-binarystring.html
  // https://www.postgresql.org/docs/current/functions-datetime.html
  // https://www.postgresql.org/docs/current/functions-json.html
  // https://www.postgresql.org/docs/current/functions-srf.html
  ...cases('postgresql', [
    ['array_prepend(n, ints)', 'array<number>', 'array_sort({value})'],
    ['array_prepend(s, texts)', 'array<string>', 'array_sort({value})'],
    ['array_append(bools, false)', 'array<boolean>', 'array_sort({value})'],
    ['array_remove(bools, false)', 'array<boolean>', 'array_sort({value})'],
    ['array_replace(bools, true, false)', 'array<boolean>', 'array_sort({value})'],
    ['array_append(texts, NULL)', 'array<string>'],
    ['array_remove(texts, NULL)', 'array<string>'],
    ["array_replace(texts, NULL, 'x')", 'array<string>'],
    ['array_cat(ints, NULL)', 'array<number>'],
    ['trim_array(ints, NULL)', 'array<number>'],
    ['array_dims(ints)', 'string', 'lower({value})'],
    ['array_length(ints, 1)', 'number', 'substring(s, {value}, 1)'],
    ['array_lower(ints, 1)', 'number', 'substring(s, {value}, 1)'],
    ['array_upper(ints, 1)', 'number', 'substring(s, {value}, 1)'],
    ['array_ndims(ints)', 'number', 'substring(s, {value}, 1)'],
    ['array_position(texts, s)', 'number', 'substring(s, {value}, 1)'],
    ["array_to_string(texts, ',')", 'string', 'lower({value})'],
    ['ints || ints', 'array<number>', 'array_sort({value})'],
    ['ints || n', 'array<number>', 'array_sort({value})'],
    ['n || ints', 'array<number>', 'array_sort({value})'],
    ['ascii(s)', 'number', 'substring(s, {value}, 1)'],
    ['nullif(s, NULL)', 'string'],
    ['parse_ident(s)', 'array<string>', 'array_sort({value})'],
    ['pg_typeof(n)', 'REGTYPE'],
    ["jsonb_extract_path_text(CAST(s AS JSONB), 'a')", 'string'],
    ['to_json(n)', 'JSON'],
    ['to_jsonb(n)', 'JSONB'],
    ['jsonb_typeof(CAST(s AS JSONB))', 'string', 'lower({value})'],
    ['jsonb_pretty(CAST(s AS JSONB))', 'string', 'lower({value})'],
    ['jsonb_object_keys(CAST(s AS JSONB))', 'string', 'lower({value})'],
    ['jsonb_array_elements_text(CAST(s AS JSONB))', 'string', 'lower({value})'],
    ['jsonb_strip_nulls(CAST(s AS JSONB), false)', 'JSONB'],
    ["jsonb_set(CAST(s AS JSONB), ARRAY['a'], CAST('false' AS JSONB), true)", 'JSONB'],
    ["jsonb_insert(CAST(s AS JSONB), ARRAY['a'], CAST('false' AS JSONB), true)", 'JSONB'],
    ['age(ts, ts)', 'INTERVAL'],
    ['make_interval(days => 1)', 'INTERVAL'],
    ['bin || bin', 'binary'],
    ['reverse(bin)', 'binary'],
    ['sha224(bin)', 'binary'],
    ['sha384(bin)', 'binary'],
    ['substring(bin FROM 1 FOR 2)', 'binary'],
    ["trim(BOTH CAST('x' AS BYTEA) FROM bin)", 'binary'],
    ['btrim(bin, bin)', 'binary'],
    ['ltrim(bin, bin)', 'binary'],
    ['rtrim(bin, bin)', 'binary'],
    ['overlay(bin PLACING bin FROM 1)', 'binary'],
    ['overlay(s PLACING s FROM 1)', 'string'],
    ['get_byte(bin, 0)', 'number'],
    ['get_bit(bin, 0)', 'number'],
    ['set_byte(bin, 0, 1)', 'binary'],
    ['set_bit(bin, 0, 1)', 'binary'],
    ["convert_from(bin, 'UTF8')", 'string'],
    ['unnest(texts)', 'string'],
    ['generate_series(1, 3)', 'number'],
    ["generate_series(ts, ts, INTERVAL '1 day')", 'time'],
  ]),
  // https://trino.io/docs/current/functions/array.html
  // https://trino.io/docs/current/functions/aggregate.html
  // https://trino.io/docs/current/functions/binary.html
  // https://trino.io/docs/current/functions/datetime.html
  // https://trino.io/docs/current/functions/regexp.html
  // https://trino.io/docs/current/functions/json.html
  ...cases('trino', [
    ['array_max(texts)', 'string', 'lower({value})'],
    ['array_min(texts)', 'string', 'lower({value})'],
    ['array_first(texts)', 'string', 'lower({value})'],
    ['array_last(texts)', 'string', 'lower({value})'],
    ['array_position(texts, s)', 'number', 'substring(s, {value}, 1)'],
    ['array_remove(bools, false)', 'array<boolean>', 'transform({value}, x -> NOT x)'],
    ['array_remove(texts, NULL)', 'array<string>'],
    ['reverse(ints)', 'array<number>', 'transform({value}, x -> x + 1)'],
    ['repeat(n, 3)', 'array<number>', 'transform({value}, x -> x + 1)'],
    ["array_join(texts, ',')", 'string', 'lower({value})'],
    ["regexp_extract_all(s, '(.)')", 'array<string>', 'transform({value}, x -> upper(x))'],
    ['if(flag, s, NULL)', 'string'],
    ['if(flag, NULL, s)', 'string'],
    ['nullif(s, NULL)', 'string'],
    ['min_by(s, false)', 'string', 'lower({value})'],
    ['max_by(s, true)', 'string', 'lower({value})'],
    ['map_agg(s, false)', 'map<string,boolean>'],
    ['map_agg(s, NULL)', 'map<string,unknown>'],
    ['multimap_agg(s, false)', 'map<string,array<boolean>>'],
    ['multimap_agg(s, NULL)', 'map<string,array<unknown>>'],
    ['md5(bin)', 'binary'],
    ['sha1(bin)', 'binary'],
    ['xxhash64(bin)', 'binary'],
    ['from_utf8(bin)', 'string', 'lower({value})'],
    ['from_base32(s)', 'binary'],
    ['from_base64(s)', 'binary'],
    ['from_base64url(s)', 'binary'],
    ['from_hex(s)', 'binary'],
    ['from_base(s, 16)', 'number'],
    ['from_big_endian_32(bin)', 'number'],
    ['from_big_endian_64(bin)', 'number'],
    ['from_ieee754_32(bin)', 'number'],
    ['from_ieee754_64(bin)', 'number'],
    ['substring(bin, 1, 2)', 'binary'],
    ['substr(bin, 1)', 'binary'],
    ['reverse(bin)', 'binary'],
    ["date_add('day', 1, ts)", 'time'],
    ["date_parse(s, '%Y-%m-%d')", 'time'],
    ['json_parse(s)', 'JSON'],
  ]),
  // https://dev.mysql.com/doc/refman/8.4/en/string-functions.html
  // https://dev.mysql.com/doc/refman/8.4/en/date-and-time-functions.html
  // https://dev.mysql.com/doc/refman/8.4/en/information-functions.html
  // https://dev.mysql.com/doc/refman/8.4/en/miscellaneous-functions.html
  ...cases('mysql', [
    ['ascii(s)', 'number', 'substring(s, {value}, 1)'],
    ['ord(s)', 'number', 'substring(s, {value}, 1)'],
    ['coercibility(s)', 'number', 'substring(s, {value}, 1)'],
    ['uuid_short()', 'number', 'substring(s, {value}, 1)'],
    ['if(flag, s, NULL)', 'string'],
    ['if(flag, NULL, s)', 'string'],
    ['nullif(s, NULL)', 'string'],
    ['isnull(s)', 'number', 'substring(s, {value}, 1)'],
    ['from_base64(s)', 'binary'],
    ["convert_tz(ts, '+00:00', '+01:00')", 'time'],
    ['date_add(ts, INTERVAL 1 DAY)', 'time'],
    ['date_sub(ts, INTERVAL 1 DAY)', 'time'],
    ["str_to_date(s, '%Y-%m-%d')", 'date'],
    ["str_to_date(s, '%Y-%m-%d %H:%i:%s')", 'time'],
    ["from_unixtime(n, '%Y')", 'string', 'lower({value})'],
    ['substring(bin, 1, 2)', 'binary'],
    ['reverse(bin)', 'binary'],
  ]),
  // https://impala.apache.org/docs/build/html/topics/impala_conditional_functions.html
  // https://impala.apache.org/docs/build/html/topics/impala_string_functions.html
  // https://impala.apache.org/docs/build/html/topics/impala_math_functions.html
  // https://impala.apache.org/docs/build/html/topics/impala_datetime_functions.html
  ...cases('impala', [
    ['ascii(s)', 'number', 'substring(s, {value}, 1)'],
    ['nvl2(n, s, s)', 'string', 'lower({value})'],
    ['nullif(s, NULL)', 'string'],
    ['if(flag, s, NULL)', 'string'],
    ['if(flag, NULL, s)', 'string'],
    ['nullvalue(s)', 'boolean'],
    ['nonnullvalue(s)', 'boolean'],
    ['decode(n, 1, s, s)', 'string'],
    ['from_unixtime(n)', 'string', 'lower({value})'],
    ["date_trunc('day', ts)", 'time'],
    ["date_trunc('day', d)", 'date'],
    ['date_add(ts, 1)', 'time'],
    ['date_sub(ts, 1)', 'time'],
    ['days_add(ts, 1)', 'time'],
    ['hours_add(ts, 1)', 'time'],
    ['minutes_add(ts, 1)', 'time'],
    ['years_add(ts, 1)', 'time'],
    ['months_between(ts, ts)', 'number'],
    ['int_months_between(ts, ts)', 'number'],
    ['to_date(ts)', 'string', 'lower({value})'],
    ['base64decode(s)', 'string', 'lower({value})'],
    ['unhex(s)', 'string', 'lower({value})'],
  ]),
  // Portable window functions: a NULL default must not become the value argument.
  // https://www.postgresql.org/docs/current/functions-window.html
  // https://dev.mysql.com/doc/refman/8.4/en/window-function-descriptions.html
  ...SQL_DIALECTS.flatMap((dialect) => cases(dialect, [
    ['lead(s, 1, NULL) OVER (ORDER BY n)', 'string'],
    ['lag(s, 1, NULL) OVER (ORDER BY n)', 'string'],
  ])),
  ...cases('generic', [
    ['substring(bin FROM 1 FOR 2)', 'binary'],
  ]),
];

export interface FunctionDiagnosticCase {
  dialect: SqlDialect;
  expression: string;
}

// These calls can have the correct return family and still reject legal arguments.
export const functionDiagnosticCases: readonly FunctionDiagnosticCase[] = [
  { dialect: 'flink', expression: 'MAP[s, false]' },
  { dialect: 'flink', expression: 'MAP[s, NULL]' },
  ...(['flink', 'postgresql'] as const).flatMap((dialect) => [
    'array_sort(ints, false)',
    'array_sort(ints, false, true)',
    'array_sort(ints, flag)',
    'array_sort(ints, flag, flag)',
  ].map((expression) => ({ dialect, expression }))),
  ...SQL_DIALECTS.flatMap((dialect) => [
    'substring(s, 1, NULL)',
    'substring(s, NULL, 2)',
  ].map((expression) => ({ dialect, expression }))),
  ...(['spark', 'hive', 'mysql', 'flink'] as const).map((dialect) => ({
    dialect, expression: 'sha2(s, NULL)',
  })),
  ...(['spark', 'trino'] as const).map((dialect) => ({
    dialect, expression: 'split(s, s, NULL)',
  })),
  ...(['spark', 'hive', 'mysql', 'postgresql', 'trino', 'generic'] as const).flatMap((dialect) => (
    ['substring(bin, 1, 2)', 'substr(bin, 1)'].map((expression) => ({ dialect, expression }))
  )),
  { dialect: 'postgresql', expression: "substring(s FROM '(.)')" },
  { dialect: 'postgresql', expression: "substring(s, '(.)')" },
  { dialect: 'postgresql', expression: `substring(s FROM '%#"o_a#"_' FOR '#')` },
  { dialect: 'postgresql', expression: "length(bin, 'UTF8')" },
];
