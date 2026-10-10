import {
  AliasExpr,
  ColumnExpr,
  CommandExpr,
  CreateExpr,
  CteExpr,
  DataTypeExpr,
  DeleteExpr,
  DropExpr,
  Expression,
  FuncExpr,
  IdentifierExpr,
  InsertExpr,
  JoinExpr,
  LateralExpr,
  LiteralExpr,
  MergeExpr,
  SchemaExpr,
  SelectExpr,
  SetOperationExpr,
  StarExpr,
  SubqueryExpr,
  TableExpr,
  UnnestExpr,
  UpdateExpr,
  WithExpr,
  parse,
} from '@hdnax/sqlingo.js';
import '@hdnax/sqlingo.js/hive';
import '@hdnax/sqlingo.js/mysql';
import '@hdnax/sqlingo.js/postgres';
import '@hdnax/sqlingo.js/spark';
import '@hdnax/sqlingo.js/trino';

import { maskPlaceholders } from './patterns';
import type { SqlDialect } from './sql';
import { maskSqlParserGaps } from './sqlParserGaps';
import { SQL_AST_DIALECTS, sqlSourceFunction, sqlSourceTypeName } from './sqlParserAdapters';

export type SqlAstRole =
  | 'alias'
  | 'column'
  | 'create'
  | 'cte'
  | 'data-type'
  | 'delete'
  | 'drop'
  | 'expression'
  | 'function'
  | 'identifier'
  | 'insert'
  | 'join'
  | 'lateral'
  | 'literal'
  | 'merge'
  | 'schema'
  | 'select'
  | 'set-operation'
  | 'star'
  | 'subquery'
  | 'table'
  | 'unnest'
  | 'update'
  | 'with';

export type SqlAstValue = SqlAstNode | readonly SqlAstValue[] | string | number | boolean | undefined;

/** Package-neutral AST consumed by the offline checker. */
export interface SqlAstNode {
  readonly role: SqlAstRole;
  readonly kind: string;
  readonly name: string;
  readonly alias: string;
  readonly aliasColumns: readonly string[];
  readonly outputName: string;
  readonly start: number;
  readonly end: number;
  /** Parser-provided start of this expression before child spans are merged. */
  readonly ownStart?: number;
  /** Exact source range of the node's own name (for example a function name). */
  readonly nameStart: number;
  readonly nameEnd: number;
  /** A real source invocation; absent for nodes synthesized by dialect rewrites. */
  readonly source?: { readonly id: number; readonly name: string; readonly start: number; readonly end: number };
  readonly args: Readonly<Record<string, SqlAstValue>>;
  /** User-supplied arguments, before parser defaults and dialect rewrites. */
  readonly call?: { readonly name: string; readonly arguments: readonly SqlAstNode[] };
}

export interface ParsedSqlAst {
  readonly statements: readonly SqlAstNode[];
  readonly parserDialect: 'flink' | 'hive' | 'mysql' | 'postgres' | 'spark' | 'trino';
}

const DIALECT_CANDIDATES: Record<SqlDialect, readonly ParsedSqlAst['parserDialect'][]> = {
  spark: ['spark'],
  hive: ['hive'],
  flink: ['flink'],
  mysql: ['mysql'],
  postgresql: ['postgres'],
  trino: ['trino'],
  impala: ['hive'],
  generic: ['trino', 'spark', 'postgres', 'mysql', 'hive'],
};

export function parseSqlAst(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[] = [],
): ParsedSqlAst | undefined {
  return parseSqlAstInternal(text, dialect, placeholders, false);
}

/** Formatting accepts opaque command nodes so their lossless token stream can still be laid out. */
export function parseSqlAstForFormatting(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[] = [],
): ParsedSqlAst | undefined {
  return parseSqlAstInternal(text, dialect, placeholders, true);
}

function parseSqlAstInternal(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  allowCommands: boolean,
): ParsedSqlAst | undefined {
  const masked = maskPlaceholders(text, placeholders).text;
  if (/\bCREATE\s+[\p{L}_$]*\s*$/iu.test(masked)) return undefined;
  for (const parserDialect of DIALECT_CANDIDATES[dialect]) {
    try {
      const parserText = allowCommands
        ? masked
        : maskSqlParserGaps(masked, dialect === 'generic' ? dialect : parserDialect);
      // The pinned Trino catalog predates standard SQL/JSON constructors. A normalized AST would
      // expose them as unsupported anonymous calls, so retain the conservative no-model fallback.
      if (dialect === 'trino' && parserText !== masked) continue;
      const statements = parse(parserText, {
        dialect: SQL_AST_DIALECTS[parserDialect],
      });
      if (!allowCommands && statements.some((statement) => statement instanceof CommandExpr)) continue;
      const normalization = createNormalizationContext();
      return {
        statements: statements.flatMap((statement) => statement ? [normalizeExpression(statement, normalization)] : []),
        parserDialect,
      };
    } catch {
      // A later candidate may accept Generic SQL. Callers retain the DT fallback.
    }
  }
  return undefined;
}

export function sqlingoCanParse(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[] = [],
): boolean {
  return parseSqlAst(text, dialect, placeholders) !== undefined;
}

export function astChild(node: SqlAstNode, key: string): SqlAstNode | undefined {
  const value = node.args[key];
  return isSqlAstNode(value) ? value : undefined;
}

export function astChildren(node: SqlAstNode, key: string): readonly SqlAstNode[] {
  const value = node.args[key];
  return Array.isArray(value) ? value.filter(isSqlAstNode) : [];
}

export type SqlAstArgumentRole = 'expression' | 'projection' | 'relation' | 'query' | 'declaration' | 'type';

/** The meaning of an AST slot, independent of a parser's expression class. */
export function astArgumentRole(node: SqlAstNode, key: string): SqlAstArgumentRole {
  if (key === 'alias' || key === 'with' || key === 'pattern' || key === 'subsets') return 'declaration';
  if (node.kind === 'kwarg' && key === 'this') return 'declaration';
  if (key === 'to' || (key === 'kind' && astChild(node, key)?.role === 'data-type')) return 'type';
  if (node.role === 'data-type' || node.role === 'schema') return 'type';
  if (key === 'expressions' && ['select', 'returning', 'pivot'].includes(node.kind)) return 'projection';
  if ((node.kind === 'matchRecognizeMeasure' && key === 'this')
    || (node.kind === 'matchRecognize' && key === 'define')) return 'projection';
  if (node.kind === 'window' && key === 'this' && astChild(node, key)?.role === 'identifier') return 'declaration';
  if (['from', 'joins', 'laterals', 'pivots', 'match'].includes(key)) return 'relation';
  if (node.role === 'subquery' && key === 'this') return 'query';
  return 'expression';
}

/** Walk expression slots only; relation/query owners supply their own scopes. */
export function astExpressionChildren(node: SqlAstNode): readonly SqlAstNode[] {
  if (node.call) return node.call.arguments;
  return Object.entries(node.args).flatMap(([key, value]) => {
    const role = astArgumentRole(node, key);
    if (role !== 'expression' && role !== 'projection' && role !== 'query') return [];
    return isSqlAstNode(value) ? [value] : Array.isArray(value) ? value.filter(isSqlAstNode) : [];
  });
}

export function walkSqlAst(node: SqlAstNode, visit: (node: SqlAstNode) => void): void {
  visit(node);
  for (const value of Object.values(node.args)) {
    if (isSqlAstNode(value)) {
      walkSqlAst(value, visit);
    } else if (Array.isArray(value)) {
      for (const child of value) {
        if (isSqlAstNode(child)) walkSqlAst(child, visit);
      }
    }
  }
}

export function isSqlAstNode(value: SqlAstValue | unknown): value is SqlAstNode {
  return value !== null && value !== undefined && typeof value === 'object'
    && !Array.isArray(value) && 'role' in value;
}

/** Returns the SQL spelling of a function call instead of the parser's class-specific AST key. */
export function astFunctionName(node: SqlAstNode, text: string): string {
  // Retain the existing API while source spelling now comes solely from parser provenance.
  void text;
  if (node.source) return node.source.name;
  if (node.kind === 'anonymous' && node.name) return node.name.replace(/^!/u, '');
  return AST_FUNCTION_NAMES[node.kind] ?? camelCaseToSqlName(node.kind);
}

interface NormalizationContext {
  readonly nodes: WeakMap<Expression, SqlAstNode>;
  readonly sourceArguments: Map<number, readonly SqlAstNode[]>;
}

function createNormalizationContext(): NormalizationContext {
  return { nodes: new WeakMap(), sourceArguments: new Map() };
}

function normalizeExpression(expression: Expression, context: NormalizationContext): SqlAstNode {
  const cached = context.nodes.get(expression);
  if (cached) return cached;
  const args: Record<string, SqlAstValue> = {};
  for (const [key, value] of Object.entries(expression.args)) {
    const normalized = normalizeValue(value, context);
    if (normalized !== undefined) args[key] = normalized;
  }
  const source = sqlSourceFunction(expression);
  const ownStart = source?.start ?? numericMeta(expression.meta.start);
  const ownEnd = numericMeta(expression.meta.end);
  const childSpans = Object.values(args).flatMap(collectValueSpans);
  const start = minimum([
    ...(ownStart === undefined ? [] : [ownStart]),
    ...childSpans.map((span) => span.start),
  ]) ?? 0;
  const end = maximum([
    ...(source ? [source.nameEnd] : []),
    ...(ownEnd === undefined ? [] : [ownEnd + 1]),
    ...childSpans.map((span) => span.end),
  ]) ?? start;
  const role = expressionRole(expression);
  let sourceArguments: readonly SqlAstNode[] | undefined;
  if (source?.arguments) {
    sourceArguments = context.sourceArguments.get(source.id);
    if (!sourceArguments) {
      sourceArguments = source.arguments.map((argument) => normalizeExpression(argument, context));
      context.sourceArguments.set(source.id, sourceArguments);
    }
  }
  const node: SqlAstNode = {
    role,
    kind: expressionKind(expression),
    name: sqlSourceTypeName(expression) ?? expression.name,
    alias: expression.alias,
    aliasColumns: expression.aliasColumnNames,
    outputName: expression.outputName,
    start,
    end,
    ownStart,
    nameStart: source?.start ?? start,
    nameEnd: source?.nameEnd ?? (role === 'function' || role === 'unnest' ? start : end),
    ...(source ? { source: { id: source.id, name: source.name, start: source.start, end: source.nameEnd } } : {}),
    args,
    ...(sourceArguments ? { call: {
      name: source!.name, arguments: sourceArguments,
    } } : {}),
  };
  context.nodes.set(expression, node);
  return node;
}

const AST_FUNCTION_NAMES: Readonly<Record<string, string>> = {
  arrayFilter: 'filter',
  approxQuantile: 'approx_percentile',
  argMax: 'max_by',
  argMin: 'min_by',
  cast: 'cast',
  chr: 'chr',
  dateDiff: 'date_diff',
  decodeCase: 'decode',
  extract: 'extract',
  groupConcat: 'string_agg',
  jsonArrayAgg: 'json_agg',
  jsonExtract: 'json_extract',
  jsonObjectAgg: 'json_objectagg',
  quantile: 'percentile',
  regexpSplit: 'split',
  strPosition: 'position',
  substring: 'substring',
  tsOrDsAdd: 'date_add',
  tsOrDsDiff: 'date_diff',
  xmlElement: 'xmlelement',
  xmlTable: 'xmltable',
};

function camelCaseToSqlName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLocaleLowerCase();
}

function normalizeValue(value: unknown, context: NormalizationContext): SqlAstValue {
  if (value instanceof Expression) return normalizeExpression(value, context);
  if (Array.isArray(value)) {
    return value.flatMap((entry): SqlAstValue[] => {
      const normalized = normalizeValue(entry, context);
      return normalized === undefined ? [] : [normalized];
    });
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function collectValueSpans(value: SqlAstValue): Array<{ start: number; end: number }> {
  // Metadata-less leaves (notably data types) have an empty range, not a
  // source token at offset zero. Only real source spans can bound a parent.
  if (isSqlAstNode(value)) return value.end > value.start ? [{ start: value.start, end: value.end }] : [];
  if (Array.isArray(value)) return value.flatMap(collectValueSpans);
  return [];
}

function expressionRole(expression: Expression): SqlAstRole {
  if (expression instanceof SelectExpr) return 'select';
  if (expression instanceof SetOperationExpr) return 'set-operation';
  if (expression instanceof ColumnExpr) return 'column';
  if (expression instanceof TableExpr) return 'table';
  if (expression instanceof SubqueryExpr) return 'subquery';
  if (expression instanceof JoinExpr) return 'join';
  if (expression instanceof LateralExpr) return 'lateral';
  if (expression instanceof UnnestExpr) return 'unnest';
  if (expression instanceof InsertExpr) return 'insert';
  if (expression instanceof UpdateExpr) return 'update';
  if (expression instanceof DeleteExpr) return 'delete';
  if (expression instanceof MergeExpr) return 'merge';
  if (expression instanceof CreateExpr) return 'create';
  if (expression instanceof DropExpr) return 'drop';
  if (expression instanceof CteExpr) return 'cte';
  if (expression instanceof WithExpr) return 'with';
  if (expression instanceof SchemaExpr) return 'schema';
  if (expression instanceof DataTypeExpr) return 'data-type';
  if (expression instanceof AliasExpr) return 'alias';
  if (expression instanceof IdentifierExpr) return 'identifier';
  if (expression instanceof StarExpr) return 'star';
  if (expression instanceof LiteralExpr) return 'literal';
  if (expression instanceof FuncExpr) return 'function';
  return 'expression';
}

function expressionKind(expression: Expression): string {
  return String((expression.constructor as { key?: string }).key ?? 'expression');
}

function numericMeta(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function minimum(values: readonly number[]): number | undefined {
  return values.length > 0 ? Math.min(...values) : undefined;
}

function maximum(values: readonly number[]): number | undefined {
  return values.length > 0 ? Math.max(...values) : undefined;
}
