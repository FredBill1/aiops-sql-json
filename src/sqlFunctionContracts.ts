import type { SqlDialect } from './sql';
import type { SqlFunctionParameter, SqlFunctionReturnRule, SqlFunctionSignature } from './sqlFunctionSignatures';

type Contracts = Readonly<Record<string, readonly SqlFunctionSignature[]>>;
/** Canonical parser operations can retain semantics outside a catalog's name set. */
export const AST_FUNCTION_RETURN_RULES: Readonly<Record<string, SqlFunctionReturnRule>> = {
  arrayAgg: { kind: 'array', element: { kind: 'argument', index: 0 } },
};
const any: SqlFunctionParameter = { type: 'ANY' };
const number: SqlFunctionParameter = { type: 'NUMBER' };
const string: SqlFunctionParameter = { type: 'STRING' };
const binary: SqlFunctionParameter = { type: 'BINARY' };
const array: SqlFunctionParameter = { type: 'ARRAY' };
const optionalNumber: SqlFunctionParameter = { ...number, optional: true };
const optionalBoolean: SqlFunctionParameter = { type: 'BOOLEAN', optional: true };
const variadic: SqlFunctionParameter = { type: 'ANY', variadic: true };
const argument = (index = 0): SqlFunctionReturnRule => ({ kind: 'argument', index });
const fixed = (type: string): SqlFunctionReturnRule => ({ kind: 'fixed', type });
const signature = (parameters: readonly SqlFunctionParameter[], returns: SqlFunctionReturnRule): SqlFunctionSignature => (
  { parameters, returns }
);
const returns = (names: string, rule: SqlFunctionReturnRule): Contracts => Object.fromEntries(
  names.split(/\s+/u).filter(Boolean).map((name) => [name, [{
    ...signature([variadic], rule), argumentValidation: 'partial',
  }]]),
);
const substrings = [
  signature([string, number, optionalNumber], argument()),
  signature([binary, number, optionalNumber], argument()),
];
const branches: SqlFunctionReturnRule = { kind: 'common', indexes: [1, 2] };
const decodeBranches = signature([any, any, any, variadic], { kind: 'alternating-results', start: 2 });
const element: SqlFunctionReturnRule = { kind: 'array-element', index: 0 };

/**
 * Reviewed SQL contracts. Groups specify dialect applicability; names are exact,
 * never prefixes. Broad parameter lists describe partial input knowledge, not
 * permission to infer a return type from arbitrary arguments.
 * Sources: catalog/function-catalog.sources.json (the pinned SQL references).
 */
export const PORTABLE_FUNCTION_CONTRACTS: Contracts = {
  ...returns('ascii char_length character_length', fixed('INT')),
  ...returns('sum avg min max first last first_value last_value nth_value lead lag nullif reverse', argument()),
  ...returns('coalesce ifnull nvl greatest least', { kind: 'common' }),
  ...Object.fromEntries(['lower', 'upper', 'lcase', 'ucase'].map((name) => [
    name, [signature([string], fixed('STRING'))],
  ])),
  ...returns('concat_ws', fixed('STRING')),
  ...returns('trim ltrim rtrim btrim overlay', argument()),
  if: [signature([{ type: 'BOOLEAN' }, any, { ...any, optional: true }], branches)],
  nvl2: [signature([any, any, any], branches)],
  substring: substrings,
  substr: substrings,
};

const collections: Contracts = {
  ...returns(`array_append array_cat array_compact array_concat array_distinct array_except array_insert
    array_intersect array_prepend array_remove array_replace array_sample array_shuffle array_union
    map_concat shuffle slice sort_array trim_array`, argument()),
  ...returns('array_max array_min array_first array_last element get', element),
  ...returns('array_position array_size array_length array_lower array_upper array_ndims', fixed('NUMBER')),
  ...returns('array_join array_to_string array_dims', fixed('STRING')),
  ...returns('regexp_extract_all regexp_split_to_array parse_ident', { kind: 'array', element: fixed('STRING') }),
};

const textEncoding: Contracts = {
  ...returns('encode', fixed('BINARY')),
  ...returns('decode from_unixtime', fixed('STRING')),
};
const booleanPredicates = returns('isnull isnotnull isnan nullvalue nonnullvalue', fixed('BOOLEAN'));
const intervalConstructors = returns('make_interval make_dt_interval make_ym_interval age', {
  kind: 'opaque', name: 'INTERVAL', typeArguments: [],
});
const numericDates: Contracts = {
  ...returns('months_between', fixed('DOUBLE')),
  ...returns('int_months_between', fixed('INT')),
  ...returns('to_unix_timestamp', fixed('BIGINT')),
};
const booleanArraySort = [signature([array, optionalBoolean, optionalBoolean], argument())];

const perDialect: Readonly<Record<SqlDialect, Contracts>> = {
  spark: {
    ...collections, ...textEncoding, ...booleanPredicates, ...intervalConstructors, ...numericDates,
    ...returns('crc32 xxhash64 bitmap_count array_position', fixed('BIGINT')),
    ...returns('hash array_size', fixed('INT')),
    ...returns('to_number try_to_number', fixed('DECIMAL')),
    ...returns('md5 sha sha1 to_json', fixed('STRING')),
    ...returns('try_to_binary', fixed('BINARY')),
    ...returns('trunc', fixed('DATE')),
    sort_array: [signature([array, optionalBoolean], argument())],
    decode: [signature([binary, string], fixed('STRING')), decodeBranches],
  },
  hive: {
    ...collections, ...textEncoding, ...booleanPredicates, ...numericDates,
    ...returns('trunc last_day next_day add_months', fixed('STRING')),
    sort_array: [signature([array], argument())],
  },
  flink: {
    ...collections, ...textEncoding, ...booleanPredicates,
    ...returns('json_array json_object', fixed('VARCHAR')),
    array_sort: booleanArraySort,
    split: [signature([string, string], { kind: 'array', element: fixed('VARCHAR') })],
  },
  postgresql: {
    ...collections, ...intervalConstructors,
    ...returns('to_json row_to_json', fixed('JSON')),
    ...returns('to_jsonb jsonb_strip_nulls jsonb_set jsonb_insert', fixed('JSONB')),
    ...returns(`jsonb_extract_path_text json_extract_path_text jsonb_typeof json_typeof jsonb_pretty
      jsonb_object_keys json_object_keys jsonb_array_elements_text json_array_elements_text convert_from`, fixed('TEXT')),
    ...returns('sha224 sha384 set_byte set_bit', fixed('BYTEA')),
    ...returns('get_byte get_bit', fixed('INT')),
    ...returns('array_position array_length array_lower array_upper array_ndims', fixed('INT')),
    ...returns('pg_typeof', { kind: 'opaque', name: 'REGTYPE', typeArguments: [] }),
    ...returns('generate_series', argument()),
    array_prepend: [signature([any, array], argument(1))],
    cardinality: [signature([any], fixed('INT'))],
    array_sort: booleanArraySort,
    substring: [...substrings, signature([string, string, { ...string, optional: true }], fixed('TEXT'))],
    length: [signature([any, { ...string, optional: true }], fixed('INT'))],
  },
  trino: {
    ...collections,
    ...returns('md5 sha1 xxhash64 from_base32 from_base64 from_base64url from_hex', fixed('VARBINARY')),
    ...returns('from_base from_big_endian_64 array_position', fixed('BIGINT')),
    ...returns('from_big_endian_32', fixed('INT')),
    ...returns('from_ieee754_32', fixed('REAL')),
    ...returns('from_ieee754_64', fixed('DOUBLE')),
    ...returns('from_utf8', fixed('VARCHAR')),
    ...returns('date_parse', fixed('TIMESTAMP')),
    ...returns('json_parse', fixed('JSON')),
    repeat: [signature([any, number], { kind: 'array', element: argument() })],
    date_add: [signature([string, number, any], argument(2))],
  },
  mysql: {
    ...returns('ord coercibility uuid_short isnull', fixed('BIGINT')),
    ...returns('from_base64', fixed('VARBINARY')),
    ...returns('convert_tz', fixed('DATETIME')),
    ...returns('date_add date_sub', argument()),
    str_to_date: [signature([string, string], { kind: 'format-temporal', index: 1 })],
    from_unixtime: [signature([number], fixed('DATETIME')), signature([number, string], fixed('VARCHAR'))],
  },
  impala: {
    ...booleanPredicates, ...numericDates,
    ...returns('from_unixtime to_date base64decode unhex', fixed('STRING')),
    ...returns('date_add date_sub days_add days_sub hours_add hours_sub minutes_add minutes_sub years_add years_sub months_add months_sub', argument()),
    date_trunc: [signature([string, any], argument(1))],
    decode: [decodeBranches],
  },
  generic: {},
};

export function reviewedFunctionSignatures(dialect: SqlDialect, name: string): readonly SqlFunctionSignature[] | undefined {
  return perDialect[dialect][name];
}
