import {
  AliasExpr,
  ColumnExpr,
  CommandExpr,
  CreateExpr,
  CteExpr,
  DataTypeExpr,
  DropExpr,
  Expression,
  FuncExpr,
  IdentifierExpr,
  InsertExpr,
  JoinExpr,
  LateralExpr,
  LiteralExpr,
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

export type SqlAstRole =
  | 'alias'
  | 'column'
  | 'create'
  | 'cte'
  | 'data-type'
  | 'drop'
  | 'expression'
  | 'function'
  | 'identifier'
  | 'insert'
  | 'join'
  | 'lateral'
  | 'literal'
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
  /** Exact source range of the node's own name (for example a function name). */
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly args: Readonly<Record<string, SqlAstValue>>;
}

export interface ParsedSqlAst {
  readonly statements: readonly SqlAstNode[];
  readonly parserDialect: 'hive' | 'mysql' | 'postgres' | 'spark' | 'trino';
}

const DIALECT_CANDIDATES: Record<SqlDialect, readonly ParsedSqlAst['parserDialect'][]> = {
  spark: ['spark'],
  hive: ['hive'],
  flink: ['trino'],
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
  const masked = maskPlaceholders(text, placeholders).text;
  if (/\bCREATE\s+[\p{L}_$]*\s*$/iu.test(masked)) return undefined;
  for (const parserDialect of DIALECT_CANDIDATES[dialect]) {
    try {
      const statements = parse(maskSqlingoParserGaps(masked, parserDialect), { dialect: parserDialect });
      if (statements.some((statement) => statement instanceof CommandExpr)) continue;
      return {
        statements: statements.flatMap((statement) => (
          statement ? [decorateNameSpans(normalizeExpression(statement), masked)] : []
        )),
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

function maskSqlingoParserGaps(text: string, dialect: ParsedSqlAst['parserDialect']): string {
  if (dialect !== 'mysql' || !/\bJSON_TABLE\b/iu.test(text)) return text;
  return text.replace(/\bEXISTS(?=\s+PATH\b)/giu, (value) => ' '.repeat(value.length));
}

export function astChild(node: SqlAstNode, key: string): SqlAstNode | undefined {
  const value = node.args[key];
  return isSqlAstNode(value) ? value : undefined;
}

export function astChildren(node: SqlAstNode, key: string): readonly SqlAstNode[] {
  const value = node.args[key];
  return Array.isArray(value) ? value.filter(isSqlAstNode) : [];
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

function normalizeExpression(expression: Expression): SqlAstNode {
  const args: Record<string, SqlAstValue> = {};
  for (const [key, value] of Object.entries(expression.args)) {
    const normalized = normalizeValue(value);
    if (normalized !== undefined) args[key] = normalized;
  }
  const ownStart = numericMeta(expression.meta.start);
  const ownEnd = numericMeta(expression.meta.end);
  const childSpans = Object.values(args).flatMap(collectValueSpans);
  const start = minimum([
    ...(ownStart === undefined ? [] : [ownStart]),
    ...childSpans.map((span) => span.start),
  ]) ?? 0;
  const end = maximum([
    ...(ownEnd === undefined ? [] : [ownEnd + 1]),
    ...childSpans.map((span) => span.end),
  ]) ?? start;
  return {
    role: expressionRole(expression),
    kind: expressionKind(expression),
    name: expression.name,
    alias: expression.alias,
    aliasColumns: expression.aliasColumnNames,
    outputName: expression.outputName,
    start,
    end,
    nameStart: start,
    nameEnd: end,
    args,
  };
}

function decorateNameSpans(node: SqlAstNode, text: string): SqlAstNode {
  const args = Object.fromEntries(Object.entries(node.args).map(([key, value]) => [
    key,
    decorateValueNameSpans(value, text),
  ]));
  const own = exactNodeNameSpan(node, text);
  return {
    ...node,
    args,
    nameStart: own.start,
    nameEnd: own.end,
  };
}

function decorateValueNameSpans(value: SqlAstValue, text: string): SqlAstValue {
  if (isSqlAstNode(value)) return decorateNameSpans(value, text);
  if (Array.isArray(value)) return value.map((entry) => decorateValueNameSpans(entry, text));
  return value;
}

function exactNodeNameSpan(node: SqlAstNode, text: string): { start: number; end: number } {
  if (node.role === 'identifier' || node.role === 'literal') {
    return { start: node.start, end: node.end };
  }
  if (node.role !== 'function' && node.role !== 'unnest') {
    return { start: node.start, end: node.end };
  }
  const rawName = node.name || node.kind;
  const name = rawName.replace(/^!/u, '');
  if (!name || name === 'anonymous') return { start: node.start, end: node.end };
  const childStarts = Object.values(node.args).flatMap(collectValueSpans).map((span) => span.start);
  const before = childStarts.length > 0 ? Math.min(...childStarts) : node.end;
  const searchStart = Math.max(0, Math.min(node.start, before) - name.length - 32);
  const searchEnd = Math.min(text.length, Math.max(before, node.end) + 1);
  const segment = text.slice(searchStart, searchEnd);
  const matcher = new RegExp(`\\b${escapeRegExp(name)}\\b(?=\\s*\\()`, 'giu');
  let best: RegExpExecArray | undefined;
  for (const match of segment.matchAll(matcher)) {
    const absolute = searchStart + match.index;
    if (absolute <= before) best = match;
  }
  if (!best) return { start: node.start, end: Math.min(node.end, node.start + name.length) };
  const start = searchStart + best.index;
  return { start, end: start + best[0].length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeValue(value: unknown): SqlAstValue {
  if (value instanceof Expression) return normalizeExpression(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry): SqlAstValue[] => {
      const normalized = normalizeValue(entry);
      return normalized === undefined ? [] : [normalized];
    });
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function collectValueSpans(value: SqlAstValue): Array<{ start: number; end: number }> {
  if (isSqlAstNode(value)) return [{ start: value.start, end: value.end }];
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
