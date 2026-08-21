import type { SqlDialect } from './sql';

export type SqlFunctionKind = 'scalar' | 'aggregate' | 'window' | 'generator' | 'table';

export type SqlFunctionParameterType =
  | 'ANY'
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'DATE'
  | 'TIME'
  | 'BINARY'
  | 'ARRAY'
  | 'MAP'
  | 'COMPLEX'
  | 'LAMBDA';

export interface SqlFunctionParameter {
  readonly type: SqlFunctionParameterType;
  readonly optional?: boolean;
  readonly variadic?: boolean;
}

export type SqlFunctionReturnRule =
  | { readonly kind: 'fixed'; readonly type: string }
  | { readonly kind: 'argument'; readonly index: number }
  | { readonly kind: 'common'; readonly indexes?: readonly number[] }
  | { readonly kind: 'array'; readonly element: SqlFunctionReturnRule }
  | { readonly kind: 'array-element'; readonly index: number }
  | { readonly kind: 'map-keys'; readonly index: number }
  | { readonly kind: 'map-values'; readonly index: number }
  | { readonly kind: 'element-at'; readonly index: number }
  | { readonly kind: 'concat' }
  | { readonly kind: 'from-json' }
  | { readonly kind: 'array-constructor' }
  | { readonly kind: 'map-constructor' }
  | { readonly kind: 'struct-constructor'; readonly named: boolean }
  | { readonly kind: 'higher-order'; readonly name: string }
  | { readonly kind: 'generator'; readonly name: string }
  | { readonly kind: 'dynamic'; readonly display: string };

export interface SqlFunctionSignature {
  readonly parameters: readonly SqlFunctionParameter[];
  readonly returns: SqlFunctionReturnRule;
}

export interface SqlFunctionDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly kind: SqlFunctionKind;
  readonly signatures: readonly SqlFunctionSignature[];
}

export const SQL_FUNCTION_CATALOG_VERSIONS: Readonly<Record<SqlDialect, string>> = {
  spark: '4.2.0',
  hive: '4.2.0',
  flink: '2.3.0',
  mysql: '26.7.0',
  postgresql: '18.6',
  trino: '483',
  impala: '4.5.0',
  generic: 'portable-common-2026-08',
};

const FIXED = (type: string): SqlFunctionReturnRule => ({ kind: 'fixed', type });
const ARGUMENT = (index = 0): SqlFunctionReturnRule => ({ kind: 'argument', index });
const COMMON: SqlFunctionReturnRule = { kind: 'common' };
const ANY_VARIADIC: SqlFunctionParameter = { type: 'ANY', variadic: true, optional: true };

const AGGREGATE_FUNCTIONS = words(`
  ANY ANY_VALUE APPROX_COUNT_DISTINCT APPROX_DISTINCT APPROX_MOST_FREQUENT APPROX_PERCENTILE
  APPROX_SET APPROX_TOP_K ARRAY_AGG APPX_MEDIAN ARBITRARY AVG BIT_AND BIT_AND_AGG BIT_OR
  BIT_OR_AGG BIT_XOR BITMAP_AND_AGG BITMAP_CONSTRUCT_AGG BITMAP_OR_AGG BOOL_AND BOOL_OR
  CHECKSUM COLLECT COLLECT_LIST COLLECT_SET CORR COUNT COUNT_IF COVAR_POP COVAR_SAMP EVERY
  FIRST GROUP_CONCAT HISTOGRAM JSON_AGG JSON_ARRAYAGG JSON_OBJECTAGG JSONB_AGG JSONB_OBJECT_AGG
  KURTOSIS LAST LISTAGG MAKE_SET_DIGEST MAX MAX_BY MEAN MEDIAN MIN MIN_BY MODE MULTIMAP_AGG
  NDV NUMERIC_HISTOGRAM PERCENTILE PERCENTILE_APPROX PERCENTILE_CONT PERCENTILE_DISC QDIGEST_AGG
  REDUCE_AGG REGR_AVGX REGR_AVGY REGR_COUNT REGR_INTERCEPT REGR_R2 REGR_SLOPE REGR_SXX
  REGR_SXY REGR_SYY SKEWNESS SOME STD STDDEV STDDEV_POP STDDEV_SAMP STRING_AGG SUM TDIGEST_AGG
  VAR_POP VAR_SAMP VARIANCE
`);

const WINDOW_FUNCTIONS = words(`
  CUME_DIST DENSE_RANK FIRST_VALUE LAG LAST_VALUE LEAD NTH_VALUE NTILE PERCENT_RANK RANK
  ROW_NUMBER
`);

const GENERATOR_FUNCTIONS = words(`
  EXPLODE EXPLODE_OUTER INLINE INLINE_OUTER JSON_TABLE JSON_TUPLE PARSE_URL_TUPLE POSEXPLODE
  POSEXPLODE_OUTER STACK UNNEST VARIANT_EXPLODE VARIANT_EXPLODE_OUTER XMLTABLE
`);

const BOOLEAN_RESULTS = words(`
  ALL_MATCH ANY_MATCH ARRAY_CONTAINS ARRAYS_OVERLAP ASSERT_TRUE BOOL_AND BOOL_OR CONTAINS
  CONTAINS_SEQUENCE ENDSWITH ENDS_WITH EQUAL_NULL EVERY EXISTS FORALL IN_FILE ISFINITE IS_INF
  IS_INFINITE IS_NAN IS_UUID IS_VALID_UTF8 IS_VALID_VARIANT IS_VARIANT_NULL JSON_ARRAY_CONTAINS
  JSON_CONTAINS JSON_CONTAINS_PATH JSON_EXISTS JSON_OVERLAPS JSON_SCHEMA_VALID JSON_VALID
  LUHN_CHECK MAP_CONTAINS_KEY NONE_MATCH REGEXP REGEXP_LIKE RLIKE STARTSWITH STARTS_WITH
  ST_CONTAINS ST_CROSSES ST_DISJOINT ST_EQUALS ST_INTERSECTS ST_ISCLOSED ST_ISEMPTY ST_ISRING
  ST_ISSIMPLE ST_ISVALID ST_OVERLAPS ST_TOUCHES ST_WITHIN TRY_VALIDATE_UTF8 VALIDATE_PASSWORD_STRENGTH
  XMLEXISTS XPATH_EXISTS
`);

const NUMBER_RESULTS = words(`
  ABS ACOS ACOSH ASIN ASINH ATAN ATAN2 ATANH AVG BIT_COUNT BIT_GET BIT_LENGTH CARDINALITY CBRT
  CEIL CEILING CHAR_LENGTH CHARACTER_LENGTH CODEPOINT CORR COS COSH COT COUNT COUNT_IF CRC32
  CUME_DIST DATE_DIFF DATE_PART DATEDIFF DAY DAYOFMONTH DAYOFWEEK DAYOFYEAR DAY_OF_MONTH
  DAY_OF_WEEK DAY_OF_YEAR DEGREES DENSE_RANK DIV E EXP EXPM1 EXTRACT FACTORIAL FIND_IN_SET FLOOR
  GETBIT GREAT_CIRCLE_DISTANCE GROUPING GROUPING_ID HAMMING_DISTANCE HASH HEIGHT HOUR HYPOT
  INDEX INSTR JARO_DISTANCE JARO_DIST JARO_SIMILARITY JARO_SIM JARO_WINKER_DISTANCE JW_DST
  JARO_WINKER_SIMILARITY JW_SIM JSON_ARRAY_LENGTH JSON_DEPTH JSON_LENGTH JSON_SIZE LCM LENGTH
  LEVENSHTEIN LEVENSHTEIN_DISTANCE LN LOCATE LOG LOG10 LOG1P LOG2 MAX_INT MAX_TINYINT
  MAX_SMALLINT MAX_BIGINT MICROSECOND MILLISECOND MINUTE MOD MONTH NPOINTS NTILE NUMGEOMETRIES
  NUMINTERIORRINGS NUMPOINTS OCTET_LENGTH PERCENT_RANK PI PMOD POSITION POW POWER QUARTER RADIANS
  RAND RAND_INTEGER RANDOM RANK REGR_COUNT REGR_INTERCEPT REGR_R2 REGR_SLOPE ROUND ROW_NUMBER
  SCALE SECOND SIGN SIGNUM SIZE SQRT ST_AREA ST_COORDDIM ST_DIMENSION ST_DISTANCE ST_LENGTH ST_NUMGEOMETRIES
  ST_NUMINTERIORRING ST_NUMINTERIORRINGS ST_NUMPOINTS ST_SRID ST_X ST_XMAX ST_XMIN ST_Y ST_YMAX
  ST_YMIN ST_Z STRPOS TAN TANH TIME_DIFF TIME_TO_MICROS TIME_TO_MILLIS TIME_TO_SECONDS
  TIMESTAMPDIFF TO_MILLISECONDS TO_SECONDS TO_UNIXTIME UNIX_DATE UNIX_MICROS UNIX_MILLIS
  UNIX_SECONDS UNIX_TIMESTAMP VAR_POP VAR_SAMP VARIANCE VECTOR_DIM WEEK WEEKDAY WEEKOFYEAR WIDTH
  WIDTH_BUCKET XPATH_DOUBLE XPATH_FLOAT XPATH_INT XPATH_LONG XPATH_NUMBER XPATH_SHORT YEAR
`);

const STRING_RESULTS = words(`
  ASCII BASE64 BASE64ENCODE BIN BIN_TO_UUID BTRIM CHAR CHAR2HEXINT CHARSET CHR COERCIBILITY
  COLLATION CONCAT_WS CONVERT_TZ CURRENT_CATALOG CURRENT_DATABASE CURRENT_PATH CURRENT_ROLE
  CURRENT_SCHEMA CURRENT_USER DATABASE DATE_FORMAT DATE_PART DECODE ELT ENCODE ENDSWITH
  ENDS_WITH FORMAT FORMAT_DATETIME FORMAT_NUMBER FORMAT_STRING FROM_BASE FROM_BASE32 FROM_BASE64
  FROM_BASE64URL FROM_HEX FROM_JSON FROM_UNIXTIME FROM_UTF8 GET_JSON_OBJECT HEX HMAC_MD5 HMAC_SHA1
  HMAC_SHA256 HMAC_SHA512 HOST INITCAP INSERT JSON_EXTRACT_SCALAR JSON_FORMAT JSON_PRETTY JSON_QUOTE
  JSON_TYPE JSON_UNQUOTE LCASE LEFT LOWER LPAD LTRIM MAKE_VALID_UTF8 MASK MD5 MONTHNAME NETWORK
  NORMALIZE OCT PARSE_IDENT PARSE_URL PG_CLIENT_ENCODING PRINTF QUOTE QUOTE_IDENT QUOTE_LITERAL
  QUOTE_NULLABLE RANDSTR REGEXP_ESCAPE REGEXP_EXTRACT REGEXP_REPLACE REGEXP_SUBSTR REPEAT REPLACE
  REVERSE RIGHT RPAD RTRIM SESSION_USER SHA SHA1 SHA2 SHA224 SHA256 SHA384 SHA512 SOUNDEX SPACE
  SPLIT_PART STARTSWITH STARTS_WITH ST_ASTEXT ST_ASEWKT ST_GEOMETRYTYPE STRLEFT STRRIGHT SUBSTR
  SUBSTRING SUBSTRING_INDEX SYSTEM_USER TIME_FORMAT TIMEOFDAY TITLE_CASE TO_BASE TO_BASE32 TO_BASE64
  TO_BASE64URL TO_CHAR TO_HEX TO_ISO8601 TO_VARCHAR TRANSLATE TRIM TYPEOF UCASE UPPER URL_DECODE
  URL_ENCODE URL_EXTRACT_FRAGMENT URL_EXTRACT_HOST URL_EXTRACT_PARAMETER URL_EXTRACT_PATH
  URL_EXTRACT_PROTOCOL URL_EXTRACT_QUERY USER UUID UUID_SHORT UUID_TO_BIN VERSION XPATH_STRING
`);

const DATE_RESULTS = words(`
  CURRENT_DATE CURDATE DATE DATE_ADD DATE_FROM_UNIX_DATE DATE_SUB FROM_ISO8601_DATE LAST_DAY
  LAST_DAY_OF_MONTH MAKE_DATE MAKEDATE NEXT_DAY TO_DATE TRY_TO_DATE
`);

const TIME_RESULTS = words(`
  CLOCK_TIMESTAMP CURRENT_ROW_TIMESTAMP CURRENT_TIME CURRENT_TIMESTAMP CURTIME FROM_ISO8601_TIMESTAMP
  FROM_ISO8601_TIMESTAMP_NANOS FROM_UNIXTIME LOCALTIME LOCALTIMESTAMP MAKE_TIME MAKE_TIMESTAMP
  MAKE_TIMESTAMP_LTZ MAKE_TIMESTAMP_NTZ NOW PARSE_DATETIME STATEMENT_TIMESTAMP SYSDATE TIME
  TIME_FROM_MICROS TIME_FROM_MILLIS TIME_FROM_SECONDS TIME_TRUNC TIMESTAMP TIMESTAMP_MICROS
  TIMESTAMP_MILLIS TIMESTAMP_SECONDS TO_TIME TO_TIMESTAMP TO_TIMESTAMP_LTZ TO_TIMESTAMP_NTZ
  TRANSACTION_TIMESTAMP TRY_MAKE_TIMESTAMP TRY_MAKE_TIMESTAMP_LTZ TRY_MAKE_TIMESTAMP_NTZ
  TRY_TO_TIME TRY_TO_TIMESTAMP UNIX_TIMESTAMP UTC_DATE UTC_TIME UTC_TIMESTAMP
`);

const BINARY_RESULTS = words(`
  AES_DECRYPT AES_ENCRYPT BASE64DECODE COMPRESS CONVERT_TO DECODE FROM_BIG_ENDIAN_32
  FROM_BIG_ENDIAN_64 FROM_IEEE754_32 FROM_IEEE754_64 FROM_UTF8 HMAC_MD5 HMAC_SHA1 HMAC_SHA256
  HMAC_SHA512 MD5 MURMUR3 SHA1 SHA256 SHA512 SPOOKY_HASH_V2_32 SPOOKY_HASH_V2_64 ST_ASBINARY
  ST_ASEWKB TO_BIG_ENDIAN_32 TO_BIG_ENDIAN_64 TO_BINARY TO_IEEE754_32 TO_IEEE754_64 TO_UTF8
  UNBASE64 UNHEX UUID_TO_BIN XXHASH64
`);

const ARRAY_RESULTS = words(`
  ARRAY_APPEND ARRAY_CAT ARRAY_COMPACT ARRAY_DISTINCT ARRAY_EXCEPT ARRAY_FILL ARRAY_INSERT
  ARRAY_INTERSECT ARRAY_POSITIONS ARRAY_PREPEND ARRAY_REMOVE ARRAY_REPEAT ARRAY_REPLACE ARRAY_SAMPLE
  ARRAY_SHUFFLE ARRAY_SORT ARRAY_UNION ARRAYS_ZIP COMBINATIONS FILTER FLATTEN GENERATE_SERIES
  MAP_ENTRIES MAP_KEYS MAP_VALUES NGRAMS REGEXP_EXTRACT_ALL REGEXP_SPLIT SEQUENCE SHUFFLE SLICE
  SORT_ARRAY SPLIT STRING_TO_ARRAY TRANSFORM TRIM_ARRAY ZIP ZIP_WITH
`);

const MAP_RESULTS = words(`
  MAP_CONCAT MAP_FILTER MAP_FROM_ARRAYS MAP_FROM_ENTRIES MAP_UNION MAP_ZIP_WITH MULTIMAP_FROM_ENTRIES
  SPLIT_TO_MAP SPLIT_TO_MULTIMAP STR_TO_MAP TRANSFORM_KEYS TRANSFORM_VALUES
`);

const SAME_AS_FIRST = words(`
  ANY_VALUE ARRAY_APPEND ARRAY_CAT ARRAY_COMPACT ARRAY_DISTINCT ARRAY_EXCEPT ARRAY_INSERT
  ARRAY_INTERSECT ARRAY_PREPEND ARRAY_REMOVE ARRAY_REPLACE ARRAY_SAMPLE ARRAY_SHUFFLE ARRAY_SORT
  ARRAY_UNION COALESCE FILTER FIRST FIRST_VALUE GREATEST IFNULL LAG LAST LAST_VALUE LEAD LEAST
  MAP_CONCAT MAP_FILTER MAX MIN NTH_VALUE NULLIF NVL NVL2 REVERSE SHUFFLE SLICE SORT_ARRAY
  TRANSFORM_KEYS TRANSFORM_VALUES TRIM_ARRAY TRY_ELEMENT_AT
`);

const EXPLICIT_SIGNATURES: Readonly<Record<string, readonly SqlFunctionSignature[]>> = {
  split: [signature(
    [{ type: 'STRING' }, { type: 'STRING' }, { type: 'NUMBER', optional: true }],
    { kind: 'array', element: FIXED('STRING') },
  )],
  regexp_split: [signature([{ type: 'STRING' }, { type: 'STRING' }], { kind: 'array', element: FIXED('STRING') })],
  concat: [signature([{ type: 'ANY', variadic: true }], { kind: 'concat' })],
  transform: [signature([{ type: 'ARRAY' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'transform' })],
  filter: [signature([{ type: 'ARRAY' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'filter' })],
  arrayfilter: [signature([{ type: 'ARRAY' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'filter' })],
  exists: [signature([{ type: 'ARRAY' }, { type: 'LAMBDA' }], FIXED('BOOLEAN'))],
  forall: [signature([{ type: 'ARRAY' }, { type: 'LAMBDA' }], FIXED('BOOLEAN'))],
  aggregate: [signature([ANY_VARIADIC], { kind: 'higher-order', name: 'aggregate' })],
  reduce: [signature([ANY_VARIADIC], { kind: 'higher-order', name: 'reduce' })],
  zip_with: [signature([{ type: 'ARRAY' }, { type: 'ARRAY' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'zip_with' })],
  map_filter: [signature([{ type: 'MAP' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'map_filter' })],
  map_zip_with: [signature([{ type: 'MAP' }, { type: 'MAP' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'map_zip_with' })],
  transform_keys: [signature([{ type: 'MAP' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'transform_keys' })],
  transform_values: [signature([{ type: 'MAP' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'transform_values' })],
  array_sort: [
    signature([{ type: 'ARRAY' }], ARGUMENT()),
    signature([{ type: 'ARRAY' }, { type: 'LAMBDA' }], { kind: 'higher-order', name: 'array_sort' }),
  ],
  from_json: [signature([{ type: 'STRING' }, { type: 'STRING' }, { type: 'MAP', optional: true }], { kind: 'from-json' })],
  array: [signature([{ type: 'ANY', variadic: true, optional: true }], { kind: 'array-constructor' })],
  map: [signature([{ type: 'ANY', variadic: true, optional: true }], { kind: 'map-constructor' })],
  struct: [signature([{ type: 'ANY', variadic: true, optional: true }], { kind: 'struct-constructor', named: false })],
  named_struct: [signature([{ type: 'ANY', variadic: true, optional: true }], { kind: 'struct-constructor', named: true })],
  element_at: [signature([{ type: 'ANY' }, { type: 'ANY' }], { kind: 'element-at', index: 0 })],
  try_element_at: [signature([{ type: 'ANY' }, { type: 'ANY' }], { kind: 'element-at', index: 0 })],
  map_keys: [signature([{ type: 'MAP' }], { kind: 'map-keys', index: 0 })],
  map_values: [signature([{ type: 'MAP' }], { kind: 'map-values', index: 0 })],
  explode: [signature([{ type: 'ANY' }], { kind: 'generator', name: 'explode' })],
  explode_outer: [signature([{ type: 'ANY' }], { kind: 'generator', name: 'explode_outer' })],
  posexplode: [signature([{ type: 'ANY' }], { kind: 'generator', name: 'posexplode' })],
  posexplode_outer: [signature([{ type: 'ANY' }], { kind: 'generator', name: 'posexplode_outer' })],
  unnest: [signature([{ type: 'ANY', variadic: true }], { kind: 'generator', name: 'unnest' })],
  count: [signature([{ type: 'ANY', variadic: true, optional: true }], FIXED('BIGINT'))],
  row_number: [signature([], FIXED('BIGINT'))],
  rank: [signature([], FIXED('BIGINT'))],
  dense_rank: [signature([], FIXED('BIGINT'))],
  size: [signature([{ type: 'ANY' }], FIXED('INT'))],
  cardinality: [signature([{ type: 'ANY' }], FIXED('BIGINT'))],
  lower: [signature([{ type: 'STRING' }], FIXED('STRING'))],
  upper: [signature([{ type: 'STRING' }], FIXED('STRING'))],
  length: [signature([{ type: 'ANY' }], FIXED('BIGINT'))],
  substring: [signature([{ type: 'STRING' }, { type: 'NUMBER' }, { type: 'NUMBER', optional: true }], FIXED('STRING'))],
  substr: [signature([{ type: 'STRING' }, { type: 'NUMBER' }, { type: 'NUMBER', optional: true }], FIXED('STRING'))],
  sha2: [signature([{ type: 'ANY' }, { type: 'NUMBER' }], FIXED('STRING'))],
};

export function buildSqlFunctionDefinitions(
  dialect: SqlDialect,
  names: readonly string[],
): readonly SqlFunctionDefinition[] {
  return names.map((name) => createDefinition(dialect, name));
}

export function formatSqlFunctionSignature(
  name: string,
  signatureValue: SqlFunctionSignature,
): string {
  const parameters = signatureValue.parameters.map((parameter) => {
    const suffix = parameter.variadic ? '...' : parameter.optional ? '?' : '';
    return `${parameter.type}${suffix}`;
  }).join(', ');
  return `${name}(${parameters}) -> ${returnRuleText(signatureValue.returns)}`;
}

function createDefinition(dialect: SqlDialect, rawName: string): SqlFunctionDefinition {
  const name = rawName.toLocaleLowerCase();
  const upper = rawName.toUpperCase();
  const explicit = EXPLICIT_SIGNATURES[name];
  const kind: SqlFunctionKind = GENERATOR_FUNCTIONS.has(upper)
    ? 'generator'
    : WINDOW_FUNCTIONS.has(upper)
      ? 'window'
      : AGGREGATE_FUNCTIONS.has(upper)
        ? 'aggregate'
        : 'scalar';
  return {
    name: rawName,
    aliases: [],
    kind,
    signatures: explicit ?? [signature([ANY_VARIADIC], inferredReturnRule(dialect, upper))],
  };
}

function inferredReturnRule(dialect: SqlDialect, name: string): SqlFunctionReturnRule {
  if (BOOLEAN_RESULTS.has(name) || /^(?:IS|HAS)_/u.test(name)) return FIXED('BOOLEAN');
  if (NUMBER_RESULTS.has(name)) return FIXED(numberType(dialect));
  if (DATE_RESULTS.has(name)) return FIXED('DATE');
  if (TIME_RESULTS.has(name)) return FIXED('TIMESTAMP');
  if (BINARY_RESULTS.has(name)) return FIXED(binaryType(dialect));
  if (STRING_RESULTS.has(name)) return FIXED(stringType(dialect));
  if (SAME_AS_FIRST.has(name)) return ARGUMENT();
  if (name === 'ARRAY_POSITIONS') return { kind: 'array', element: FIXED('BIGINT') };
  if (name.startsWith('ARRAY_')) return ARGUMENT();
  if (ARRAY_RESULTS.has(name)) return { kind: 'array', element: ARGUMENT() };
  if (MAP_RESULTS.has(name) || name.startsWith('MAP_')) return { kind: 'dynamic', display: 'MAP' };
  if (AGGREGATE_FUNCTIONS.has(name) || WINDOW_FUNCTIONS.has(name)) return ARGUMENT();
  return COMMON;
}

function numberType(dialect: SqlDialect): string {
  return dialect === 'postgresql' ? 'NUMERIC' : dialect === 'mysql' ? 'DECIMAL' : 'DOUBLE';
}

function stringType(dialect: SqlDialect): string {
  return dialect === 'postgresql' ? 'TEXT' : dialect === 'mysql' || dialect === 'trino' || dialect === 'flink'
    ? 'VARCHAR'
    : 'STRING';
}

function binaryType(dialect: SqlDialect): string {
  if (dialect === 'postgresql') return 'BYTEA';
  if (dialect === 'trino' || dialect === 'flink' || dialect === 'mysql') return 'VARBINARY';
  return 'BINARY';
}

function signature(
  parameters: readonly SqlFunctionParameter[],
  returns: SqlFunctionReturnRule,
): SqlFunctionSignature {
  return { parameters, returns };
}

function returnRuleText(rule: SqlFunctionReturnRule): string {
  switch (rule.kind) {
    case 'fixed': return rule.type;
    case 'argument': return `ARG${rule.index + 1}`;
    case 'common': return 'COMMON';
    case 'array': return `ARRAY<${returnRuleText(rule.element)}>`;
    case 'array-element': return `ELEMENT(ARG${rule.index + 1})`;
    case 'map-keys': return `ARRAY<KEY(ARG${rule.index + 1})>`;
    case 'map-values': return `ARRAY<VALUE(ARG${rule.index + 1})>`;
    case 'element-at': return `ELEMENT(ARG${rule.index + 1})`;
    case 'concat': return 'CONCAT_TYPE';
    case 'from-json': return 'PARSED_SCHEMA';
    case 'array-constructor': return 'ARRAY<COMMON>';
    case 'map-constructor': return 'MAP<COMMON, COMMON>';
    case 'struct-constructor': return 'STRUCT';
    case 'higher-order': return rule.name.toUpperCase();
    case 'generator': return `TABLE<${rule.name.toUpperCase()}>`;
    case 'dynamic': return rule.display;
  }
}

function words(value: string): ReadonlySet<string> {
  return new Set(value.trim().split(/\s+/u).filter(Boolean));
}
