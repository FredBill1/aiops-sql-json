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
  | { readonly kind: 'multiset'; readonly element: SqlFunctionReturnRule }
  | { readonly kind: 'map'; readonly key: SqlFunctionReturnRule; readonly value: SqlFunctionReturnRule }
  | { readonly kind: 'opaque'; readonly name: string; readonly typeArguments: readonly SqlFunctionReturnRule[] }
  | {
      readonly kind: 'record';
      readonly recordKind: 'struct' | 'row';
      readonly fields: readonly { readonly name: string; readonly type: SqlFunctionReturnRule }[];
    }
  | { readonly kind: 'array-element'; readonly index: number }
  | { readonly kind: 'map-key'; readonly index: number }
  | { readonly kind: 'map-value'; readonly index: number }
  | { readonly kind: 'map-keys'; readonly index: number }
  | { readonly kind: 'map-values'; readonly index: number }
  | { readonly kind: 'field'; readonly index: number; readonly field: string | number; readonly arrayElement?: boolean }
  | { readonly kind: 'type-argument'; readonly index: number; readonly argument: number }
  | { readonly kind: 'element-at'; readonly index: number }
  | { readonly kind: 'schema-literal'; readonly index: number }
  | { readonly kind: 'zip-record'; readonly recordKind: 'struct' | 'row' }
  | { readonly kind: 'json-query'; readonly stringType: string }
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
  readonly signatureSource: 'explicit' | 'fallback';
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

/** Versions whose composite-returning functions were reviewed against the upstream documentation. */
export const SQL_FUNCTION_SHAPE_REVIEW_VERSIONS: Readonly<Record<SqlDialect, string>> = {
  spark: '4.2.0',
  hive: '4.2.0',
  flink: '2.3.0',
  mysql: '26.7.0',
  postgresql: '18.6',
  trino: '483',
  impala: '4.5.0',
  generic: 'portable-common-2026-08',
};

/** Composite signatures that must never silently fall back to the broad name-based heuristics. */
export const SQL_SHAPE_SENSITIVE_FUNCTIONS: Readonly<Partial<Record<SqlDialect, readonly string[]>>> = {
  spark: [
    'APPROX_PERCENTILE', 'APPROX_TOP_K', 'ARRAY_AGG', 'ARRAYS_ZIP', 'COLLECT_LIST', 'COLLECT_SET',
    'FILTER', 'FLATTEN', 'FROM_CSV', 'FROM_JSON', 'FROM_XML', 'HISTOGRAM_NUMERIC', 'JSON_OBJECT_KEYS',
    'MAP_ENTRIES', 'MAP_FILTER', 'MAP_FROM_ARRAYS', 'MAP_FROM_ENTRIES', 'MAP_ZIP_WITH', 'MAX_BY', 'MIN_BY',
    'PERCENTILE', 'PERCENTILE_APPROX', 'SENTENCES', 'SESSION_WINDOW', 'STR_TO_MAP', 'TRANSFORM',
    'TRANSFORM_KEYS', 'TRANSFORM_VALUES', 'WINDOW', 'XPATH', 'ZIP_WITH',
  ],
  hive: [
    'COLLECT_LIST', 'COLLECT_SET', 'CONTEXT_NGRAMS', 'FILTER', 'HISTOGRAM_NUMERIC',
    'NGRAMS', 'PERCENTILE', 'PERCENTILE_APPROX', 'SENTENCES', 'STR_TO_MAP', 'TRANSFORM', 'ZIP_WITH',
  ],
  flink: [
    'ARRAY_AGG', 'BITMAP_TO_ARRAY', 'COLLECT', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'JSON_QUERY',
    'MAP_ENTRIES', 'MAP_FROM_ARRAYS', 'MAP_UNION', 'PERCENTILE', 'STR_TO_MAP',
  ],
  mysql: ['JSON_ARRAY', 'JSON_ARRAYAGG', 'JSON_OBJECT', 'JSON_OBJECTAGG', 'ST_COLLECT'],
  postgresql: [
    'ARRAY_AGG', 'ARRAY_FILL', 'ARRAY_TO_JSON', 'ENUM_RANGE', 'JSON_AGG', 'JSON_AGG_STRICT',
    'JSON_ARRAY', 'JSON_ARRAYAGG', 'JSON_BUILD_ARRAY', 'JSON_OBJECT_AGG', 'JSON_OBJECTAGG', 'JSONB_AGG',
    'JSONB_BUILD_ARRAY', 'PERCENTILE_CONT', 'PERCENTILE_DISC', 'REGEXP_MATCH', 'REGEXP_MATCHES',
    'REGEXP_SPLIT_TO_ARRAY', 'STRING_TO_ARRAY', 'TSVECTOR_TO_ARRAY', 'XPATH',
  ],
  trino: [
    'APPROX_MOST_FREQUENT', 'APPROX_PERCENTILE', 'ARRAY_AGG', 'ARRAY_HISTOGRAM', 'CLASSIFY',
    'COMBINATIONS', 'FEATURES', 'FLATTEN', 'HASH_COUNTS', 'HISTOGRAM', 'MAP', 'MAP_AGG', 'MAP_ENTRIES',
    'MAP_FROM_ENTRIES', 'MAP_UNION', 'MAX', 'MAX_BY', 'MIN', 'MIN_BY', 'MULTIMAP_AGG',
    'MULTIMAP_FROM_ENTRIES', 'NGRAMS', 'NUMERIC_HISTOGRAM', 'QDIGEST_AGG', 'SPLIT_TO_MAP',
    'SPLIT_TO_MULTIMAP', 'VALUE_AT_QUANTILE', 'VALUES_AT_QUANTILES', 'ZIP',
  ],
  impala: [],
  generic: [],
};

const FIXED = (type: string): SqlFunctionReturnRule => ({ kind: 'fixed', type });
const ARGUMENT = (index = 0): SqlFunctionReturnRule => ({ kind: 'argument', index });
const ARRAY = (element: SqlFunctionReturnRule): SqlFunctionReturnRule => ({ kind: 'array', element });
const MULTISET = (element: SqlFunctionReturnRule): SqlFunctionReturnRule => ({ kind: 'multiset', element });
const MAP = (key: SqlFunctionReturnRule, value: SqlFunctionReturnRule): SqlFunctionReturnRule => ({
  kind: 'map', key, value,
});
const RECORD = (
  recordKind: 'struct' | 'row',
  fields: readonly { readonly name: string; readonly type: SqlFunctionReturnRule }[],
): SqlFunctionReturnRule => ({ kind: 'record', recordKind, fields });
const OPAQUE = (name: string, typeArguments: readonly SqlFunctionReturnRule[] = []): SqlFunctionReturnRule => ({
  kind: 'opaque', name, typeArguments,
});
const ARRAY_ELEMENT = (index: number): SqlFunctionReturnRule => ({ kind: 'array-element', index });
const MAP_KEY = (index: number): SqlFunctionReturnRule => ({ kind: 'map-key', index });
const MAP_VALUE = (index: number): SqlFunctionReturnRule => ({ kind: 'map-value', index });
const FIELD = (index: number, field: string | number, arrayElement = false): SqlFunctionReturnRule => ({
  kind: 'field', index, field, ...(arrayElement ? { arrayElement: true } : {}),
});
const TYPE_ARGUMENT = (index: number, argument = 0): SqlFunctionReturnRule => ({
  kind: 'type-argument', index, argument,
});
const COMMON: SqlFunctionReturnRule = { kind: 'common' };
const ANY_VARIADIC: SqlFunctionParameter = { type: 'ANY', variadic: true, optional: true };
const ANY: SqlFunctionParameter = { type: 'ANY' };
const NUMBER: SqlFunctionParameter = { type: 'NUMBER' };
const OPTIONAL_NUMBER: SqlFunctionParameter = { type: 'NUMBER', optional: true };
const ARRAY_PARAMETER: SqlFunctionParameter = { type: 'ARRAY' };

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
  array_repeat: [signature([{ type: 'ANY' }, { type: 'NUMBER' }], ARRAY(ARGUMENT()))],
  flatten: [signature([{ type: 'ARRAY' }], ARRAY_ELEMENT(0))],
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

const COLLECTION_ARRAY_SIGNATURES = [signature([ANY], ARRAY(ARGUMENT()))];
const PROPAGATED_PERCENTILE_SIGNATURES = [
  signature([ANY, NUMBER, OPTIONAL_NUMBER], ARGUMENT()),
  signature([ANY, ARRAY_PARAMETER, OPTIONAL_NUMBER], ARRAY(ARGUMENT())),
];
const DOUBLE_PERCENTILE_SIGNATURES = [
  signature([NUMBER, NUMBER, OPTIONAL_NUMBER], FIXED('DOUBLE')),
  signature([NUMBER, ARRAY_PARAMETER, OPTIONAL_NUMBER], ARRAY(FIXED('DOUBLE'))),
];
const HISTOGRAM_NUMERIC_SIGNATURES = [signature(
  [NUMBER, NUMBER],
  ARRAY(RECORD('struct', [
    { name: 'x', type: ARGUMENT() },
    { name: 'y', type: FIXED('DOUBLE') },
  ])),
)];
const MAP_ENTRIES_STRUCT_SIGNATURES = [signature(
  [{ type: 'MAP' }],
  ARRAY(RECORD('struct', [
    { name: 'key', type: MAP_KEY(0) },
    { name: 'value', type: MAP_VALUE(0) },
  ])),
)];
const MAP_ENTRIES_ROW_SIGNATURES = [signature(
  [{ type: 'MAP' }],
  ARRAY(RECORD('row', [
    { name: 'field0', type: MAP_KEY(0) },
    { name: 'field1', type: MAP_VALUE(0) },
  ])),
)];
const MAP_FROM_ARRAYS_SIGNATURES = [signature(
  [ARRAY_PARAMETER, ARRAY_PARAMETER],
  MAP(ARRAY_ELEMENT(0), ARRAY_ELEMENT(1)),
)];
const MAP_FROM_ENTRIES_SIGNATURES = [signature(
  [ARRAY_PARAMETER],
  MAP(FIELD(0, 0, true), FIELD(0, 1, true)),
)];

const DIALECT_SIGNATURES: Readonly<Partial<Record<SqlDialect, Readonly<Record<string, readonly SqlFunctionSignature[]>>>>> = {
  spark: {
    array_agg: COLLECTION_ARRAY_SIGNATURES,
    collect_list: COLLECTION_ARRAY_SIGNATURES,
    collect_set: COLLECTION_ARRAY_SIGNATURES,
    histogram_numeric: HISTOGRAM_NUMERIC_SIGNATURES,
    approx_percentile: PROPAGATED_PERCENTILE_SIGNATURES,
    percentile: PROPAGATED_PERCENTILE_SIGNATURES,
    percentile_approx: PROPAGATED_PERCENTILE_SIGNATURES,
    min_by: [
      signature([ANY, ANY], ARGUMENT()),
      signature([ANY, ANY, NUMBER], ARRAY(ARGUMENT())),
    ],
    max_by: [
      signature([ANY, ANY], ARGUMENT()),
      signature([ANY, ANY, NUMBER], ARRAY(ARGUMENT())),
    ],
    approx_top_k: [signature(
      [ANY, OPTIONAL_NUMBER, OPTIONAL_NUMBER],
      ARRAY(RECORD('struct', [
        { name: 'item', type: ARGUMENT() },
        { name: 'count', type: FIXED('BIGINT') },
      ])),
    )],
    count_min_sketch: [signature([NUMBER, NUMBER, NUMBER, NUMBER], FIXED('BINARY'))],
    arrays_zip: [signature([{ type: 'ARRAY', variadic: true }], { kind: 'zip-record', recordKind: 'struct' })],
    map_entries: MAP_ENTRIES_STRUCT_SIGNATURES,
    map_from_arrays: MAP_FROM_ARRAYS_SIGNATURES,
    map_from_entries: MAP_FROM_ENTRIES_SIGNATURES,
    from_csv: [signature([{ type: 'STRING' }, { type: 'STRING' }, { type: 'MAP', optional: true }], {
      kind: 'schema-literal', index: 1,
    })],
    from_xml: [signature([{ type: 'STRING' }, { type: 'STRING' }, { type: 'MAP', optional: true }], {
      kind: 'schema-literal', index: 1,
    })],
    json_object_keys: [signature([{ type: 'STRING' }], ARRAY(FIXED('STRING')))],
    str_to_map: [signature([ANY_VARIADIC], MAP(FIXED('STRING'), FIXED('STRING')))],
    sentences: [signature([ANY_VARIADIC], ARRAY(ARRAY(FIXED('STRING'))))],
    xpath: [signature([{ type: 'STRING' }, { type: 'STRING' }], ARRAY(FIXED('STRING')))],
    window: [signature([ANY_VARIADIC], RECORD('struct', [
      { name: 'start', type: FIXED('TIMESTAMP') },
      { name: 'end', type: FIXED('TIMESTAMP') },
    ]))],
    session_window: [signature([ANY_VARIADIC], RECORD('struct', [
      { name: 'start', type: FIXED('TIMESTAMP') },
      { name: 'end', type: FIXED('TIMESTAMP') },
    ]))],
  },
  hive: {
    collect_list: COLLECTION_ARRAY_SIGNATURES,
    collect_set: COLLECTION_ARRAY_SIGNATURES,
    histogram_numeric: [signature([NUMBER, NUMBER], ARRAY(RECORD('struct', [
      { name: 'x', type: FIXED('DOUBLE') },
      { name: 'y', type: FIXED('DOUBLE') },
    ])))],
    percentile: DOUBLE_PERCENTILE_SIGNATURES,
    percentile_approx: DOUBLE_PERCENTILE_SIGNATURES,
    context_ngrams: [signature([ANY_VARIADIC], ARRAY(RECORD('struct', [
      { name: 'ngram', type: ARRAY(FIXED('STRING')) },
      { name: 'estfrequency', type: FIXED('DOUBLE') },
    ])))],
    ngrams: [signature([ANY_VARIADIC], ARRAY(RECORD('struct', [
      { name: 'ngram', type: ARRAY(FIXED('STRING')) },
      { name: 'estfrequency', type: FIXED('DOUBLE') },
    ])))],
    sentences: [signature([ANY_VARIADIC], ARRAY(ARRAY(FIXED('STRING'))))],
    str_to_map: [signature([ANY_VARIADIC], MAP(FIXED('STRING'), FIXED('STRING')))],
  },
  flink: {
    array_agg: COLLECTION_ARRAY_SIGNATURES,
    collect: [signature([ANY], MULTISET(ARGUMENT()))],
    percentile: DOUBLE_PERCENTILE_SIGNATURES,
    bitmap_to_array: [signature([ANY], ARRAY(FIXED('INT')))],
    map_entries: MAP_ENTRIES_ROW_SIGNATURES,
    map_from_arrays: MAP_FROM_ARRAYS_SIGNATURES,
    map_union: [signature([{ type: 'MAP', variadic: true }], ARGUMENT())],
    str_to_map: [signature([ANY_VARIADIC], MAP(FIXED('VARCHAR'), FIXED('VARCHAR')))],
    json_query: [signature([{ type: 'STRING' }, { type: 'STRING' }], {
      kind: 'json-query', stringType: 'VARCHAR',
    })],
    json_arrayagg: [signature([ANY_VARIADIC], FIXED('VARCHAR'))],
    json_objectagg: [signature([ANY_VARIADIC], FIXED('VARCHAR'))],
  },
  mysql: {
    json_array: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_arrayagg: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_object: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_objectagg: [signature([ANY_VARIADIC], FIXED('JSON'))],
    st_collect: [signature([ANY_VARIADIC], FIXED('GEOMETRY'))],
  },
  postgresql: {
    array_agg: COLLECTION_ARRAY_SIGNATURES,
    regexp_match: [signature([ANY_VARIADIC], ARRAY(FIXED('TEXT')))],
    regexp_matches: [signature([ANY_VARIADIC], ARRAY(FIXED('TEXT')))],
    regexp_split_to_array: [signature([ANY_VARIADIC], ARRAY(FIXED('TEXT')))],
    string_to_array: [signature([ANY_VARIADIC], ARRAY(FIXED('TEXT')))],
    array_fill: [signature([ANY, ARRAY_PARAMETER, { type: 'ARRAY', optional: true }], ARRAY(ARGUMENT()))],
    enum_range: [signature([ANY, { type: 'ANY', optional: true }], ARRAY(COMMON))],
    pg_blocking_pids: [signature([NUMBER], ARRAY(FIXED('INT')))],
    pg_safe_snapshot_blocking_pids: [signature([NUMBER], ARRAY(FIXED('INT')))],
    tsvector_to_array: [signature([ANY], ARRAY(FIXED('TEXT')))],
    xpath: [signature([ANY_VARIADIC], ARRAY(FIXED('XML')))],
    percentile_cont: [
      signature([NUMBER], FIXED('DOUBLE PRECISION')),
      signature([ARRAY_PARAMETER], ARRAY(FIXED('DOUBLE PRECISION'))),
    ],
    percentile_disc: [
      signature([NUMBER], { kind: 'common', indexes: [] }),
      signature([ARRAY_PARAMETER], ARRAY({ kind: 'common', indexes: [] })),
    ],
    array_to_json: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_array: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_build_array: [signature([ANY_VARIADIC], FIXED('JSON'))],
    jsonb_build_array: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    jsonb_path_query_array: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    jsonb_path_query_array_tz: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    json_agg: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_agg_strict: [signature([ANY_VARIADIC], FIXED('JSON'))],
    jsonb_agg: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    jsonb_agg_strict: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    json_arrayagg: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_objectagg: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_object_agg: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_object_agg_strict: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_object_agg_unique: [signature([ANY_VARIADIC], FIXED('JSON'))],
    json_object_agg_unique_strict: [signature([ANY_VARIADIC], FIXED('JSON'))],
    jsonb_object_agg: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    jsonb_object_agg_strict: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    jsonb_object_agg_unique: [signature([ANY_VARIADIC], FIXED('JSONB'))],
    jsonb_object_agg_unique_strict: [signature([ANY_VARIADIC], FIXED('JSONB'))],
  },
  trino: {
    map: [
      signature([], MAP({ kind: 'common', indexes: [] }, { kind: 'common', indexes: [] })),
      signature([ARRAY_PARAMETER, ARRAY_PARAMETER], MAP(ARRAY_ELEMENT(0), ARRAY_ELEMENT(1))),
    ],
    array_agg: COLLECTION_ARRAY_SIGNATURES,
    approx_percentile: [
      signature([ANY, NUMBER], ARGUMENT()),
      signature([ANY, ARRAY_PARAMETER], ARRAY(ARGUMENT())),
      signature([ANY, NUMBER, NUMBER], ARGUMENT()),
      signature([ANY, NUMBER, ARRAY_PARAMETER], ARRAY(ARGUMENT())),
    ],
    min: [signature([ANY], ARGUMENT()), signature([ANY, NUMBER], ARRAY(ARGUMENT()))],
    max: [signature([ANY], ARGUMENT()), signature([ANY, NUMBER], ARRAY(ARGUMENT()))],
    min_by: [signature([ANY, ANY], ARGUMENT()), signature([ANY, ANY, NUMBER], ARRAY(ARGUMENT()))],
    max_by: [signature([ANY, ANY], ARGUMENT()), signature([ANY, ANY, NUMBER], ARRAY(ARGUMENT()))],
    histogram: [signature([ANY], MAP(ARGUMENT(), FIXED('BIGINT')))],
    array_histogram: [signature([ARRAY_PARAMETER], MAP(ARRAY_ELEMENT(0), FIXED('BIGINT')))],
    numeric_histogram: [signature([NUMBER, NUMBER, OPTIONAL_NUMBER], MAP(FIXED('DOUBLE'), FIXED('DOUBLE')))],
    approx_most_frequent: [signature([NUMBER, ANY, NUMBER], MAP(ARGUMENT(1), FIXED('BIGINT')))],
    map_agg: [signature([ANY, ANY], MAP(ARGUMENT(), ARGUMENT(1)))],
    multimap_agg: [signature([ANY, ANY], MAP(ARGUMENT(), ARRAY(ARGUMENT(1))))],
    map_union: [signature([{ type: 'MAP' }], ARGUMENT())],
    map_entries: MAP_ENTRIES_ROW_SIGNATURES,
    map_from_entries: MAP_FROM_ENTRIES_SIGNATURES,
    multimap_from_entries: [signature(
      [ARRAY_PARAMETER],
      MAP(FIELD(0, 0, true), ARRAY(FIELD(0, 1, true))),
    )],
    split_to_map: [signature([ANY_VARIADIC], MAP(FIXED('VARCHAR'), FIXED('VARCHAR')))],
    split_to_multimap: [signature([ANY_VARIADIC], MAP(FIXED('VARCHAR'), ARRAY(FIXED('VARCHAR'))))],
    zip: [signature([{ type: 'ARRAY', variadic: true }], { kind: 'zip-record', recordKind: 'row' })],
    flatten: [signature([ARRAY_PARAMETER], ARRAY_ELEMENT(0))],
    combinations: [signature([ARRAY_PARAMETER, NUMBER], ARRAY(ARGUMENT()))],
    ngrams: [signature([ARRAY_PARAMETER, NUMBER], ARRAY(ARGUMENT()))],
    qdigest_agg: [signature([ANY, OPTIONAL_NUMBER, OPTIONAL_NUMBER], OPAQUE('QDIGEST', [ARGUMENT()]))],
    value_at_quantile: [signature([ANY, NUMBER], TYPE_ARGUMENT(0))],
    values_at_quantiles: [signature([ANY, ARRAY_PARAMETER], ARRAY(TYPE_ARGUMENT(0)))],
    classify: [signature([ANY, { type: 'MAP' }], MAP(FIXED('VARCHAR'), FIXED('DOUBLE')))],
    features: [signature([ANY_VARIADIC], MAP(FIXED('VARCHAR'), FIXED('DOUBLE')))],
    hash_counts: [signature([ANY], MAP(FIXED('BIGINT'), FIXED('BIGINT')))],
    bing_tiles_around: [signature([ANY_VARIADIC], ARRAY(OPAQUE('BING_TILE')))],
    geometry_nearest_points: [signature([ANY_VARIADIC], ARRAY(OPAQUE('GEOMETRY')))],
    geometry_to_bing_tiles: [signature([ANY_VARIADIC], ARRAY(OPAQUE('BING_TILE')))],
    line_interpolate_points: [signature([ANY_VARIADIC], ARRAY(OPAQUE('GEOMETRY')))],
    st_envelopeaspts: [signature([ANY_VARIADIC], ARRAY(OPAQUE('GEOMETRY')))],
    st_geometries: [signature([ANY_VARIADIC], ARRAY(OPAQUE('GEOMETRY')))],
    st_interiorrings: [signature([ANY_VARIADIC], ARRAY(OPAQUE('GEOMETRY')))],
    st_points: [signature([ANY_VARIADIC], ARRAY(OPAQUE('GEOMETRY')))],
  },
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
  const explicit = DIALECT_SIGNATURES[dialect]?.[name] ?? EXPLICIT_SIGNATURES[name];
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
    signatureSource: explicit ? 'explicit' : 'fallback',
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
    case 'multiset': return `MULTISET<${returnRuleText(rule.element)}>`;
    case 'map': return `MAP<${returnRuleText(rule.key)}, ${returnRuleText(rule.value)}>`;
    case 'opaque': return rule.typeArguments.length > 0
      ? `${rule.name}<${rule.typeArguments.map(returnRuleText).join(', ')}>`
      : rule.name;
    case 'record': return `${rule.recordKind.toUpperCase()}<${rule.fields.map((field) => (
      `${field.name}: ${returnRuleText(field.type)}`
    )).join(', ')}>`;
    case 'array-element': return `ELEMENT(ARG${rule.index + 1})`;
    case 'map-key': return `KEY(ARG${rule.index + 1})`;
    case 'map-value': return `VALUE(ARG${rule.index + 1})`;
    case 'map-keys': return `ARRAY<KEY(ARG${rule.index + 1})>`;
    case 'map-values': return `ARRAY<VALUE(ARG${rule.index + 1})>`;
    case 'field': return `FIELD(ARG${rule.index + 1}, ${String(rule.field)})`;
    case 'type-argument': return `TYPE_ARG(ARG${rule.index + 1}, ${rule.argument + 1})`;
    case 'element-at': return `ELEMENT(ARG${rule.index + 1})`;
    case 'schema-literal': return `SCHEMA(ARG${rule.index + 1})`;
    case 'zip-record': return `ARRAY<${rule.recordKind.toUpperCase()}<ELEMENTS>>`;
    case 'json-query': return `${rule.stringType} | ARRAY<${rule.stringType}>`;
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
