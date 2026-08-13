import type { CommonEntityContext, EntityContext } from 'dt-sql-parser';

import { findPlaceholderRanges } from './patterns';
import { analyzeSql, getSqlEntities, lexSql, type SqlDialect, type SqlLexToken } from './sql';
import {
  astChild,
  astChildren,
  isSqlAstNode,
  parseSqlAst,
  type SqlAstNode,
  type SqlAstValue,
} from './sqlAst';
import { getSqlCatalog } from './sqlCatalog';
import {
  buildSqlSemanticIr,
  type SemanticFieldAccess,
  type SemanticLateralView,
  type SemanticReference,
} from './sqlSemanticIr';

export type SqlTypeFamily = 'number' | 'string' | 'boolean' | 'date' | 'time' | 'binary' | 'complex' | 'unknown';

export type SqlDataType =
  | { kind: 'unknown' }
  | { kind: 'scalar'; family: Exclude<SqlTypeFamily, 'complex' | 'unknown'>; name: string }
  | { kind: 'array'; elementType: SqlDataType }
  | { kind: 'map'; keyType: SqlDataType; valueType: SqlDataType }
  | { kind: 'struct'; fields: readonly SchemaColumn[] };

export interface SchemaColumn {
  name: string;
  normalizedName: string;
  type: string;
  typeFamily: SqlTypeFamily;
  dataType?: SqlDataType;
  start: number;
  end: number;
}

export interface SchemaTable {
  name: string;
  normalizedName: string;
  normalizedLeafName: string;
  kind: 'table' | 'view';
  temporary?: boolean;
  columns: readonly SchemaColumn[];
  source: string;
  start: number;
  end: number;
}

export interface SchemaIssue {
  source: string;
  start: number;
  end: number;
  message: string;
  code: string;
}

export interface SchemaSnapshot {
  tables: readonly SchemaTable[];
  issues: readonly SchemaIssue[];
}

export interface SchemaViewDefinition {
  name: string;
  normalizedName: string;
  normalizedLeafName: string;
  query: string;
  explicitColumns: readonly string[];
  dialect: SqlDialect;
  source: string;
  start: number;
  end: number;
  queryStart: number;
}

export interface ParsedDdlSchema {
  tables: SchemaTable[];
  views: SchemaViewDefinition[];
  issues: SchemaIssue[];
}

export interface SqlSemanticIssue {
  start: number;
  end: number;
  message: string;
  code: string;
  severity?: 'error' | 'warning';
}

export interface RelationBinding {
  name: string;
  aliases: readonly string[];
  columns: readonly SchemaColumn[];
  unresolved: boolean;
  dynamic?: boolean;
}

export interface SqlScopeInfo {
  fields: readonly string[];
  relations: readonly RelationBinding[];
}

interface MutableScope {
  start: number;
  end: number;
  depth: number;
  relations: RelationBinding[];
  projectionAliases: Set<string>;
}

interface AstScope extends MutableScope {
  parent?: AstScope;
}

interface CteDefinition {
  name: string;
  normalizedName: string;
  columns: SchemaColumn[];
  declarationStart: number;
  declarationEnd: number;
}

interface IdentifierReference {
  text: string;
  parts: string[];
  start: number;
  end: number;
  isFunction: boolean;
}

interface TableResolution {
  status: 'found' | 'missing' | 'ambiguous';
  table?: SchemaTable;
}

interface SqlStatementRange {
  start: number;
  end: number;
  text: string;
}

interface LocalSchemaState {
  readonly local: Map<string, SchemaTable>;
  readonly hiddenGlobalNames: Set<string>;
}

const EMPTY_SCHEMA: SchemaSnapshot = { tables: [], issues: [] };
const UNKNOWN_DATA_TYPE: SqlDataType = { kind: 'unknown' };

export function parseDdlSchema(
  text: string,
  dialect: SqlDialect,
  source: string,
): ParsedDdlSchema {
  const syntax = analyzeSql(text, dialect, []);
  if (syntax.issues.length > 0) {
    return {
      tables: [],
      views: [],
      issues: syntax.issues.map((issue) => ({
        source,
        start: issue.start,
        end: issue.end,
        message: issue.message,
        code: 'schema-ddl-syntax',
      })),
    };
  }

  const ast = parseSqlAst(text, dialect);
  if (ast) {
    const creates = ast.statements.filter((statement) => statement.role === 'create');
    if (creates.length > 0) return parseAstDdlSchema(text, dialect, source, creates);
  }

  const entities = getSqlEntities(text, dialect);
  const semanticIr = buildSqlSemanticIr(text, dialect, [], entities);
  const createTables = entities.filter((entity) => entity.entityContextType === 'tableCreate');
  const createViews = entities.filter((entity) => entity.entityContextType === 'viewCreate');
  const tables: SchemaTable[] = [];
  const views: SchemaViewDefinition[] = [];
  const issues: SchemaIssue[] = [];
  for (const entity of createTables) {
    const columns = deduplicateColumns([
      ...extractDeclaredColumns(entity, dialect),
      ...semanticIr.partitionColumns
        .filter((column) => column.start >= entity.belongStmt.position.startIndex
          && column.end <= entity.belongStmt.position.endIndex + 1)
        .map((column) => declaredColumn(column.name, column.type, column.start, column.end, dialect)),
    ]);
    if (columns.length === 0) {
      issues.push({
        source,
        start: entity.position.startIndex,
        end: entity.position.endIndex + 1,
        message: `Table ${entity.text} has no explicit column definitions and cannot be used as an offline schema.`,
        code: 'schema-table-without-columns',
      });
      continue;
    }
    const name = entity.text.trim();
    const normalizedParts = splitQualifiedName(name).map((part) => normalizeIdentifier(part.text, part.quoted, dialect));
    tables.push({
      name,
      normalizedName: normalizedParts.join('.'),
      normalizedLeafName: normalizedParts.at(-1) ?? '',
      kind: 'table',
      columns,
      source,
      start: entity.position.startIndex,
      end: entity.position.endIndex + 1,
    });
  }
  for (const entity of createViews) {
    const view = extractViewDefinition(text, entity, dialect, source);
    if (view) {
      views.push(view);
    } else {
      issues.push({
        source,
        start: entity.position.startIndex,
        end: entity.position.endIndex + 1,
        message: `View ${entity.text} has no query whose output columns can be inferred.`,
        code: 'schema-view-without-query',
      });
    }
  }
  return { tables, views, issues };
}

function parseAstDdlSchema(
  text: string,
  dialect: SqlDialect,
  source: string,
  creates: readonly SqlAstNode[],
): ParsedDdlSchema {
  const tables: SchemaTable[] = [];
  const views: SchemaViewDefinition[] = [];
  const issues: SchemaIssue[] = [];
  const statements = splitSqlStatements(text, dialect, []);
  for (const create of creates) {
    const kind = astPrimitiveString(create.args.kind).toLocaleLowerCase();
    if (kind !== 'table' && kind !== 'view') continue;
    const target = astChild(create, 'this');
    const schema = target?.role === 'schema' ? target : undefined;
    const tableNode = schema ? astChild(schema, 'this') : target;
    if (!tableNode) continue;
    const name = astTableName(tableNode);
    const parts = splitQualifiedName(name);
    const normalizedName = normalizeQualifiedName(name, dialect);
    const normalizedLeafName = parts.at(-1)
      ? normalizeIdentifier(parts.at(-1)!.text, parts.at(-1)!.quoted, dialect)
      : '';
    if (kind === 'table') {
      const declared = schema ? astChildren(schema, 'expressions').filter((node) => node.kind === 'columnDef') : [];
      const properties = astChild(create, 'properties');
      const partitionColumns = properties
        ? collectAstNodes(properties, (node) => node.kind === 'columnDef')
        : [];
      const columns = [...declared, ...partitionColumns].flatMap((definition) => {
        const identifier = astChild(definition, 'this');
        if (!identifier?.name) return [];
        const typeNode = astChild(definition, 'kind');
        const type = typeNode ? astDataTypeText(typeNode) : '';
        return [declaredColumn(identifier.name, type, identifier.start, identifier.end, dialect)];
      });
      const duplicate = firstDuplicateColumn(columns);
      if (duplicate) {
        issues.push({
          source,
          start: duplicate.start,
          end: duplicate.end,
          message: `Duplicate column ${duplicate.name} in table ${name}.`,
          code: 'duplicate-schema-column',
        });
        continue;
      }
      if (columns.length === 0) {
        issues.push({
          source,
          start: tableNode.start,
          end: tableNode.end,
          message: `Table ${name} has no explicit column definitions and cannot be used as an offline schema.`,
          code: 'schema-table-without-columns',
        });
        continue;
      }
      tables.push({
        name,
        normalizedName,
        normalizedLeafName,
        kind: 'table',
        temporary: /\bTEMP(?:ORARY)?\b/iu.test(text.slice(Math.max(0, create.start - 32), tableNode.start)),
        columns,
        source,
        start: tableNode.start,
        end: tableNode.end,
      });
      continue;
    }

    const queryNode = astChild(create, 'expression');
    if (!queryNode) {
      issues.push({
        source,
        start: tableNode.start,
        end: tableNode.end,
        message: `View ${name} has no query whose output columns can be inferred.`,
        code: 'schema-view-without-query',
      });
      continue;
    }
    const statement = statements.find((candidate) => (
      candidate.start <= tableNode.start && candidate.end >= queryNode.end
    ));
    const tokens = lexSql(text, dialect).filter((token) => token.channel === 0
      && token.start >= tableNode.end && (!statement || token.end <= statement.end));
    const asIndex = tokens.findIndex((token) => tokenUpper(token) === 'AS');
    const queryStart = asIndex >= 0 ? tokens[asIndex + 1]?.start : undefined;
    const queryEnd = statement?.end ?? queryNode.end;
    if (queryStart === undefined || queryStart >= queryEnd) {
      issues.push({
        source,
        start: tableNode.start,
        end: tableNode.end,
        message: `View ${name} has no query whose output columns can be inferred.`,
        code: 'schema-view-without-query',
      });
      continue;
    }
    const explicitColumns = schema
      ? astChildren(schema, 'expressions').filter((node) => node.role === 'identifier').map((node) => node.name)
      : [];
    views.push({
      name,
      normalizedName,
      normalizedLeafName,
      query: text.slice(queryStart, queryEnd),
      explicitColumns,
      dialect,
      source,
      start: tableNode.start,
      end: tableNode.end,
      queryStart,
    });
  }
  return { tables, views, issues };
}

function collectAstNodes(node: SqlAstNode, predicate: (candidate: SqlAstNode) => boolean): SqlAstNode[] {
  const result: SqlAstNode[] = [];
  forEachAstChild(node, (child) => {
    if (predicate(child)) result.push(child);
    result.push(...collectAstNodes(child, predicate));
  });
  return result;
}

function firstDuplicateColumn(columns: readonly SchemaColumn[]): SchemaColumn | undefined {
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.normalizedName)) return column;
    seen.add(column.normalizedName);
  }
  return undefined;
}

export function createSchemaSnapshot(
  parsed: readonly ParsedDdlSchema[],
  udfs: readonly string[] = [],
): SchemaSnapshot {
  const issues = parsed.flatMap((item) => item.issues);
  const allTables = parsed.flatMap((item) => item.tables);
  const allViews = parsed.flatMap((item) => item.views);
  const grouped = new Map<string, Array<SchemaTable | SchemaViewDefinition>>();
  for (const object of [...allTables, ...allViews]) {
    const group = grouped.get(object.normalizedName) ?? [];
    group.push(object);
    grouped.set(object.normalizedName, group);
  }
  const tables: SchemaTable[] = [];
  const views: SchemaViewDefinition[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      const object = group[0]!;
      if (isSchemaViewDefinition(object)) {
        views.push(object);
      } else {
        tables.push(object);
      }
      continue;
    }
    for (const object of group) {
      issues.push({
        source: object.source,
        start: object.start,
        end: object.end,
        message: `Duplicate schema definition for object ${object.name}.`,
        code: group.every((candidate) => !isSchemaViewDefinition(candidate))
          ? 'duplicate-schema-table'
          : 'duplicate-schema-object',
      });
    }
  }

  let pending = [...views];
  while (pending.length > 0) {
    const remaining: SchemaViewDefinition[] = [];
    let resolvedAny = false;
    for (const view of pending) {
      const snapshot: SchemaSnapshot = { tables, issues: [] };
      const model = buildSqlModel(view.query, view.dialect, snapshot, [], udfs, true);
      let columns = deriveQueryColumns(view.query, view.dialect, snapshot, new Map(), []);
      if (view.explicitColumns.length > 0 && columns.length === view.explicitColumns.length) {
        columns = view.explicitColumns.map((name, index) => {
          const inferred = columns[index];
          return virtualColumn(name, inferred?.typeFamily ?? 'unknown', inferred?.type ?? '');
        });
      }
      const validColumns = columns.length > 0 && columns.every((column) => isUsableOutputColumn(column.name));
      if (model.issues.length === 0 && validColumns
        && (view.explicitColumns.length === 0 || view.explicitColumns.length === columns.length)) {
        tables.push({
          name: view.name,
          normalizedName: view.normalizedName,
          normalizedLeafName: view.normalizedLeafName,
          kind: 'view',
          columns,
          source: view.source,
          start: view.start,
          end: view.end,
        });
        resolvedAny = true;
      } else {
        remaining.push(view);
      }
    }
    if (!resolvedAny) {
      for (const view of remaining) {
        issues.push({
          source: view.source,
          start: view.start,
          end: view.end,
          message: `View ${view.name} has unresolved dependencies or output columns that cannot be inferred.`,
          code: 'schema-view-unresolved',
        });
      }
      break;
    }
    pending = remaining;
  }
  return { tables, issues };
}

export function resolveSchemaTable(
  snapshot: SchemaSnapshot,
  name: string,
  dialect: SqlDialect,
): TableResolution {
  const normalized = normalizeQualifiedName(name, dialect);
  const exact = snapshot.tables.filter((table) => table.normalizedName === normalized);
  if (exact.length === 1) {
    return { status: 'found', table: exact[0] };
  }
  if (exact.length > 1) {
    return { status: 'ambiguous' };
  }
  const parts = splitQualifiedName(name);
  if (parts.length > 1) {
    return { status: 'missing' };
  }
  const leaf = parts[0] ? normalizeIdentifier(parts[0].text, parts[0].quoted, dialect) : '';
  const matches = snapshot.tables.filter((table) => table.normalizedLeafName === leaf);
  if (matches.length === 1) {
    return { status: 'found', table: matches[0] };
  }
  return { status: matches.length > 1 ? 'ambiguous' : 'missing' };
}

export function collectSqlFieldNames(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
): string[] {
  const model = buildSqlModel(text, dialect, EMPTY_SCHEMA, placeholders, [], false);
  const seen = new Set<string>();
  return model.references.flatMap((reference) => {
    if (reference.isFunction) {
      return [];
    }
    const name = reference.parts.at(-1);
    if (!name) {
      return [];
    }
    const key = normalizeBareIdentifier(name, dialect);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [unquoteIdentifier(name)];
  });
}

export function analyzeSqlSemantics(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  snapshot: SchemaSnapshot,
  udfs: readonly string[],
): SqlSemanticIssue[] {
  if (analyzeSql(text, dialect, placeholders).issues.length > 0) {
    return [];
  }
  const state = createLocalSchemaState();
  const issues: SqlSemanticIssue[] = [];
  for (const statement of splitSqlStatements(text, dialect, placeholders)) {
    const kind = sqlStatementKind(statement.text);
    if (kind === 'create' || kind === 'drop') {
      issues.push(...applyLocalDdl(statement, dialect, placeholders, snapshot, state, udfs, true));
    } else if (isDataStatementKind(kind)) {
      const effective = effectiveSchemaSnapshot(snapshot, state);
      issues.push(...buildSqlModel(
        statement.text,
        dialect,
        effective,
        placeholders,
        udfs,
        true,
      ).issues.map((issue) => offsetSemanticIssue(issue, statement.start)));
    }
  }
  return deduplicateSemanticIssues(issues);
}

export function getSqlSchemaAtOffset(
  text: string,
  offset: number,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  snapshot: SchemaSnapshot,
  udfs: readonly string[] = [],
): SchemaSnapshot {
  const state = createLocalSchemaState();
  for (const statement of splitSqlStatements(text, dialect, placeholders)) {
    if (statement.end > offset || (statement.end === offset && !/;\s*$/u.test(statement.text))) {
      break;
    }
    const kind = sqlStatementKind(statement.text);
    if (kind === 'create' || kind === 'drop') {
      applyLocalDdl(statement, dialect, placeholders, snapshot, state, udfs, false);
    }
  }
  return effectiveSchemaSnapshot(snapshot, state);
}

export function getSqlScopeInfo(
  text: string,
  offset: number,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  snapshot: SchemaSnapshot,
  udfs: readonly string[] = [],
): SqlScopeInfo {
  const statements = splitSqlStatements(text, dialect, placeholders);
  const statement = statements.find((candidate) => candidate.start <= offset && candidate.end >= offset)
    ?? [...statements].reverse().find((candidate) => candidate.start <= offset);
  if (!statement) {
    return { fields: [], relations: [] };
  }
  const effective = getSqlSchemaAtOffset(text, statement.start, dialect, placeholders, snapshot, udfs);
  const model = buildSqlModel(statement.text, dialect, effective, placeholders, udfs, false);
  const scopes = containingScopes(model.scopes, Math.max(0, offset - statement.start));
  const relations = scopes[0]?.relations ?? [];
  const seenRelations = new Set<string>();
  const uniqueRelations = relations.filter((relation) => {
    const key = relation.aliases.join('|');
    if (seenRelations.has(key)) {
      return false;
    }
    seenRelations.add(key);
    return true;
  });
  const fields: string[] = [];
  const seenFields = new Set<string>();
  for (const relation of uniqueRelations) {
    for (const column of relation.columns) {
      if (!seenFields.has(column.normalizedName)) {
        seenFields.add(column.normalizedName);
        fields.push(column.name);
      }
    }
  }
  return { fields, relations: uniqueRelations };
}

type SqlStatementKind = 'create' | 'drop' | 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'other';

function splitSqlStatements(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
): SqlStatementRange[] {
  const tokens = lexSql(text, dialect, placeholders).filter((token) => token.channel === 0);
  const statements: SqlStatementRange[] = [];
  let start = 0;
  let depth = 0;
  for (const token of tokens) {
    if (token.text === '(') depth += 1;
    if (token.text === ')') depth = Math.max(0, depth - 1);
    if (token.text === ';' && depth === 0) {
      appendStatementRange(statements, text, start, token.end);
      start = token.end;
    }
  }
  appendStatementRange(statements, text, start, text.length);
  return statements;
}

function appendStatementRange(
  statements: SqlStatementRange[],
  text: string,
  requestedStart: number,
  requestedEnd: number,
): void {
  let start = requestedStart;
  let end = requestedEnd;
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  if (start < end) {
    statements.push({ start, end, text: text.slice(start, end) });
  }
}

function sqlStatementKind(text: string): SqlStatementKind {
  const body = withoutLeadingSqlComments(text);
  if (/^WITH\b/iu.test(body)) return 'select';
  const match = /^(CREATE|DROP|SELECT|INSERT|UPDATE|DELETE|MERGE)\b/iu.exec(body);
  const keyword = match?.[1]?.toLocaleLowerCase();
  return keyword === 'create' || keyword === 'drop' || keyword === 'select' || keyword === 'insert'
    || keyword === 'update' || keyword === 'delete' || keyword === 'merge'
    ? keyword
    : 'other';
}

function isDataStatementKind(kind: SqlStatementKind): boolean {
  return kind === 'select' || kind === 'insert' || kind === 'update' || kind === 'delete' || kind === 'merge';
}

function createLocalSchemaState(): LocalSchemaState {
  return { local: new Map(), hiddenGlobalNames: new Set() };
}

function effectiveSchemaSnapshot(base: SchemaSnapshot, state: LocalSchemaState): SchemaSnapshot {
  const localNames = new Set(state.local.keys());
  return {
    tables: [
      ...base.tables.filter((table) => (
        !state.hiddenGlobalNames.has(table.normalizedName) && !localNames.has(table.normalizedName)
      )),
      ...state.local.values(),
    ],
    issues: base.issues,
  };
}

function applyLocalDdl(
  statement: SqlStatementRange,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  base: SchemaSnapshot,
  state: LocalSchemaState,
  udfs: readonly string[],
  reportIssues: boolean,
): SqlSemanticIssue[] {
  const text = statement.text;
  const body = withoutLeadingSqlComments(text);
  const createMatch = /^CREATE\s+(?<replace>OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?<temporary>TEMP(?:ORARY)?\s+)?(?<kind>TABLE|VIEW)\b/iu.exec(body);
  if (createMatch?.groups) {
    const kind = createMatch.groups.kind?.toLocaleLowerCase() as 'table' | 'view';
    const entities = getSqlEntities(text, dialect, placeholders);
    const entity = entities.find((candidate) => candidate.entityContextType === `${kind}Create`);
    if (!entity) return [];
    const temporary = Boolean(createMatch.groups.temporary);
    const ifNotExists = /\bIF\s+NOT\s+EXISTS\b/iu.test(text.slice(0, entity.position.startIndex));
    const orReplace = Boolean(createMatch.groups.replace);
    const effective = effectiveSchemaSnapshot(base, state);
    const existing = resolveSchemaTable(effective, entity.text, dialect);
    const normalizedName = normalizeQualifiedName(entity.text, dialect);
    const localMatch = findLocalObject(state, entity.text, dialect);
    if (existing.status !== 'missing' && !temporary && !orReplace) {
      if (ifNotExists) return [];
      return reportIssues ? [ddlIssue(
        statement,
        entity.position.startIndex,
        entity.position.endIndex + 1,
        `Cannot create ${kind} ${entity.text}; an object with that name already exists.`,
        'duplicate-local-object',
      )] : [];
    }
    if (localMatch && !orReplace) {
      if (ifNotExists) return [];
      return reportIssues ? [ddlIssue(
        statement,
        entity.position.startIndex,
        entity.position.endIndex + 1,
        `Cannot create ${kind} ${entity.text}; a local object with that name already exists.`,
        'duplicate-local-object',
      )] : [];
    }
    if (kind === 'table') {
      const semanticIr = buildSqlSemanticIr(text, dialect, placeholders, entities);
      const columns = [
        ...extractDeclaredColumns(entity, dialect),
        ...semanticIr.partitionColumns.map((column) => (
          declaredColumn(column.name, column.type, column.start, column.end, dialect)
        )),
      ];
      const duplicate = firstDuplicateColumn(columns);
      if (duplicate) {
        return reportIssues ? [ddlIssue(
          statement,
          duplicate.start,
          duplicate.end,
          `Duplicate column ${duplicate.name} in table ${entity.text}.`,
          'duplicate-schema-column',
        )] : [];
      }
      if (columns.length === 0) {
        return reportIssues ? [ddlIssue(
          statement,
          entity.position.startIndex,
          entity.position.endIndex + 1,
          `Table ${entity.text} has no explicit column definitions; CTAS does not create a local schema object.`,
          'local-table-without-columns',
        )] : [];
      }
      const parts = splitQualifiedName(entity.text);
      prepareReplacement(state, existing.table, localMatch, orReplace, temporary);
      state.local.set(normalizedName, {
        name: entity.text,
        normalizedName,
        normalizedLeafName: parts.at(-1) ? normalizeIdentifier(parts.at(-1)!.text, parts.at(-1)!.quoted, dialect) : '',
        kind: 'table',
        temporary,
        columns,
        source: 'local',
        start: statement.start + entity.position.startIndex,
        end: statement.start + entity.position.endIndex + 1,
      });
      return [];
    }

    const view = extractViewDefinition(text, entity, dialect, 'local');
    if (!view) {
      return reportIssues ? [ddlIssue(
        statement,
        entity.position.startIndex,
        entity.position.endIndex + 1,
        `View ${entity.text} has no query whose output columns can be inferred.`,
        'local-view-without-query',
      )] : [];
    }
    const queryModel = buildSqlModel(view.query, dialect, effective, placeholders, udfs, true);
    const queryIssues = queryModel.issues.map((issue) => offsetSemanticIssue(
      issue,
      statement.start + view.queryStart,
    ));
    let columns = deriveQueryColumns(view.query, dialect, effective, new Map(), placeholders);
    if (view.explicitColumns.length > 0) {
      if (view.explicitColumns.length !== columns.length) {
        return reportIssues ? [...queryIssues, ddlIssue(
          statement,
          entity.position.startIndex,
          entity.position.endIndex + 1,
          `View ${entity.text} declares ${view.explicitColumns.length} column(s), but its query returns ${columns.length}.`,
          'local-view-column-count',
        )] : [];
      }
      columns = view.explicitColumns.map((name, index) => {
        const inferred = columns[index];
        return virtualColumn(name, inferred?.typeFamily ?? 'unknown', inferred?.type ?? '');
      });
    }
    if (queryIssues.length > 0 || columns.length === 0 || !columns.every((column) => isUsableOutputColumn(column.name))) {
      return reportIssues ? [
        ...queryIssues,
        ...(queryIssues.length === 0 ? [ddlIssue(
          statement,
          entity.position.startIndex,
          entity.position.endIndex + 1,
          `View ${entity.text} has output columns that cannot be inferred.`,
          'local-view-unresolved',
        )] : []),
      ] : [];
    }
    const parts = splitQualifiedName(entity.text);
    prepareReplacement(state, existing.table, localMatch, orReplace, temporary);
    state.local.set(normalizedName, {
      name: entity.text,
      normalizedName,
      normalizedLeafName: parts.at(-1) ? normalizeIdentifier(parts.at(-1)!.text, parts.at(-1)!.quoted, dialect) : '',
      kind: 'view',
      temporary,
      columns,
      source: 'local',
      start: statement.start + entity.position.startIndex,
      end: statement.start + entity.position.endIndex + 1,
    });
    return [];
  }

  const dropMatch = /^DROP\s+(?<kind>TABLE|VIEW)\s+(?<ifExists>IF\s+EXISTS\s+)?/iu.exec(body);
  if (!dropMatch?.groups) return [];
  const kind = dropMatch.groups.kind?.toLocaleLowerCase() as 'table' | 'view';
  const entities = getSqlEntities(text, dialect, placeholders);
  const entity = entities.find((candidate) => candidate.entityContextType === kind);
  if (!entity) return [];
  const effective = effectiveSchemaSnapshot(base, state);
  const resolution = resolveSchemaTable(effective, entity.text, dialect);
  const object = resolution.table;
  if (resolution.status !== 'found' || !object || object.kind !== kind) {
    if (dropMatch.groups.ifExists && resolution.status !== 'ambiguous') return [];
    return reportIssues ? [ddlIssue(
      statement,
      entity.position.startIndex,
      entity.position.endIndex + 1,
      resolution.status === 'ambiguous'
        ? `Cannot drop ${entity.text}; the object reference is ambiguous.`
        : `Cannot drop ${kind} ${entity.text}; no matching object exists.`,
      resolution.status === 'ambiguous' ? 'ambiguous-drop-object' : 'unknown-drop-object',
    )] : [];
  }
  const local = [...state.local.values()].find((candidate) => candidate === object);
  if (local) {
    state.local.delete(local.normalizedName);
  } else {
    state.hiddenGlobalNames.add(object.normalizedName);
  }
  return [];
}

function withoutLeadingSqlComments(text: string): string {
  let remaining = text.trimStart();
  while (true) {
    const line = /^--[^\r\n]*(?:\r?\n|\r)/u.exec(remaining);
    if (line) {
      remaining = remaining.slice(line[0].length).trimStart();
      continue;
    }
    const block = /^\/\*[\s\S]*?\*\//u.exec(remaining);
    if (block) {
      remaining = remaining.slice(block[0].length).trimStart();
      continue;
    }
    return remaining;
  }
}

function prepareReplacement(
  state: LocalSchemaState,
  existing: SchemaTable | undefined,
  local: SchemaTable | undefined,
  replace: boolean,
  temporary: boolean,
): void {
  if (!replace) return;
  if (local) state.local.delete(local.normalizedName);
  if (existing && !local && !temporary) state.hiddenGlobalNames.add(existing.normalizedName);
}

function findLocalObject(
  state: LocalSchemaState,
  name: string,
  dialect: SqlDialect,
): SchemaTable | undefined {
  return resolveSchemaTable({ tables: [...state.local.values()], issues: [] }, name, dialect).table;
}

function ddlIssue(
  statement: SqlStatementRange,
  start: number,
  end: number,
  message: string,
  code: string,
): SqlSemanticIssue {
  return { start: statement.start + start, end: statement.start + end, message, code };
}

function offsetSemanticIssue(issue: SqlSemanticIssue, offset: number): SqlSemanticIssue {
  return { ...issue, start: issue.start + offset, end: issue.end + offset };
}

function buildSqlModel(
  text: string,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  placeholders: readonly RegExp[],
  udfs: readonly string[],
  validate: boolean,
): { scopes: MutableScope[]; references: IdentifierReference[]; issues: SqlSemanticIssue[] } {
  const ast = parseSqlAst(text, dialect, placeholders);
  if (ast && ast.statements.length > 0) {
    return buildAstSqlModel(text, dialect, snapshot, placeholders, udfs, validate, ast.statements);
  }
  const entities = getSqlEntities(text, dialect, placeholders);
  const tokens = lexSql(text, dialect, placeholders).filter((token) => token.channel === 0);
  const semanticIr = buildSqlSemanticIr(text, dialect, placeholders, entities);
  const placeholderRanges = findPlaceholderRanges(text, placeholders);
  const ctes = extractCtes(text, tokens, dialect, snapshot, placeholders);
  const scopes = createScopes(entities, text.length);
  const issues: SqlSemanticIssue[] = [];

  const tableEntities = flattenEntities(entities).filter((entity) => (
    (entity.entityContextType === 'table' || entity.entityContextType === 'view')
      && !semanticIr.lateralViews.some((view) => overlapsAny(entityRange(entity), [{
        start: view.functionStart,
        end: view.functionEnd,
      }]))
  ));
  for (const entity of tableEntities) {
    const scope = scopeForStatement(scopes, entity.belongStmt.position.startIndex, entity.belongStmt.position.endIndex + 1, entity.belongStmt.scopeDepth);
    if (!scope) {
      continue;
    }
    const binding = bindingForEntity(entity, text, dialect, snapshot, ctes, placeholders, placeholderRanges);
    scope.relations.push(binding);
    if (validate && binding.unresolved && !binding.dynamic && !isExpressionTable(entity)) {
      const resolution = resolveSchemaTable(snapshot, entity.text, dialect);
      issues.push({
        start: entity.position.startIndex,
        end: entity.position.endIndex + 1,
        message: resolution.status === 'ambiguous'
          ? `Table reference ${entity.text} is ambiguous in the configured schema.`
          : `Unknown table ${entity.text}.`,
        code: resolution.status === 'ambiguous' ? 'ambiguous-table' : 'unknown-table',
      });
    }
  }

  for (const entity of flattenEntities(entities)) {
    if (entity._alias && entity.entityContextType === 'column'
      && entity.position.endIndex >= entity.position.startIndex) {
      const scope = smallestContainingScope(scopes, entity.position.startIndex);
      scope?.projectionAliases.add(normalizeBareIdentifier(entity._alias.text, dialect));
    }
  }

  for (const lateralView of semanticIr.lateralViews) {
    const scope = smallestContainingScope(scopes, lateralView.start);
    if (scope) {
      scope.relations.push(bindingForLateralView(lateralView, text, scope.relations, dialect));
    }
  }

  const references = [
    ...semanticIr.references,
    ...semanticIr.lateralViews.map((view): SemanticReference => ({
      kind: 'function',
      text: view.functionName,
      start: view.functionStart,
      end: view.functionEnd,
    })),
  ].filter((reference) => !overlapsAny(reference, placeholderRanges)).map(referenceFromSemantic);
  if (validate) {
    validateReferences(references, scopes, dialect, snapshot, udfs, issues);
    validateFieldAccesses(semanticIr.fieldAccesses, text, scopes, dialect, issues);
    validateInsertShapes(text, entities, scopes, dialect, issues);
    validateUnionShapes(text, dialect, snapshot, placeholders, issues);
    validateUpdateAssignments(text, entities, scopes, dialect, issues);
  }
  return { scopes, references, issues: deduplicateSemanticIssues(issues) };
}

interface AstModelContext {
  readonly text: string;
  readonly dialect: SqlDialect;
  readonly snapshot: SchemaSnapshot;
  readonly placeholderRanges: readonly { start: number; end: number }[];
  readonly functions: ReadonlySet<string>;
  readonly validate: boolean;
  readonly scopes: AstScope[];
  readonly references: IdentifierReference[];
  readonly issues: SqlSemanticIssue[];
}

interface AstColumnResolution {
  readonly status: 'ambiguous' | 'found' | 'missing-column' | 'missing-qualifier' | 'unresolved';
  readonly column?: SchemaColumn;
}

function buildAstSqlModel(
  text: string,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  placeholders: readonly RegExp[],
  udfs: readonly string[],
  validate: boolean,
  statements: readonly SqlAstNode[],
): { scopes: MutableScope[]; references: IdentifierReference[]; issues: SqlSemanticIssue[] } {
  const catalog = getSqlCatalog(dialect);
  const context: AstModelContext = {
    text,
    dialect,
    snapshot,
    placeholderRanges: findPlaceholderRanges(text, placeholders),
    functions: new Set([
      ...catalog.functions.map((name) => normalizeQualifiedName(name, dialect)),
      ...udfs.map((name) => normalizeQualifiedName(name, dialect)),
      'explode', 'explode_outer', 'posexplode', 'posexplode_outer', 'unnest', 'json_table',
      'jsonb_array_elements', 'jsonb_array_elements_text',
      'count', 'sum', 'avg', 'min', 'max', 'row_number', 'rank', 'dense_rank',
    ]),
    validate,
    scopes: [],
    references: [],
    issues: [],
  };
  for (const statement of statements) {
    analyzeAstStatement(statement, context, new Map());
  }
  return {
    scopes: context.scopes,
    references: context.references,
    issues: deduplicateSemanticIssues(context.issues),
  };
}

function analyzeAstStatement(
  statement: SqlAstNode,
  context: AstModelContext,
  ctes: ReadonlyMap<string, RelationBinding>,
): SchemaColumn[] {
  if (statement.role === 'select' || statement.role === 'set-operation') {
    return analyzeAstQuery(statement, context, undefined, ctes);
  }
  if (statement.role === 'insert') {
    return analyzeAstInsert(statement, context, ctes);
  }
  if (statement.role === 'update') {
    analyzeAstUpdate(statement, context, ctes);
  }
  return [];
}

function analyzeAstQuery(
  query: SqlAstNode,
  context: AstModelContext,
  parent: AstScope | undefined,
  inheritedCtes: ReadonlyMap<string, RelationBinding>,
): SchemaColumn[] {
  if (query.role === 'set-operation') {
    const left = astChild(query, 'this');
    const right = astChild(query, 'expression');
    const leftColumns = left ? analyzeAstQuery(left, context, parent, inheritedCtes) : [];
    const rightColumns = right ? analyzeAstQuery(right, context, parent, inheritedCtes) : [];
    if (context.validate && left && right) {
      if (leftColumns.length !== rightColumns.length) {
        appendAstIssue(context, right, 'union-column-count',
          `UNION branch returns ${rightColumns.length} column(s); expected ${leftColumns.length}.`);
      } else {
        for (let index = 0; index < leftColumns.length; index += 1) {
          const expected = leftColumns[index]!;
          const actual = rightColumns[index]!;
          if (!areTypesCompatible(expected.typeFamily, actual.typeFamily)) {
            appendAstIssue(context, right, 'incompatible-type',
              `UNION column ${index + 1} has incompatible ${actual.typeFamily} and ${expected.typeFamily} types.`);
          }
        }
      }
    }
    return leftColumns;
  }
  if (query.role !== 'select') return deriveAstValuesColumns(query, context, parent);

  const scope: AstScope = {
    start: astQueryStart(context.text, query.start),
    end: Math.max(query.end, query.start + 1),
    depth: parent ? parent.depth + 1 : 0,
    relations: [],
    projectionAliases: new Set(),
    parent,
  };
  context.scopes.push(scope);
  const ctes = new Map(inheritedCtes);
  const withNode = astChild(query, 'with');
  for (const cte of withNode ? astChildren(withNode, 'expressions') : []) {
    if (cte.role !== 'cte') continue;
    const cteQuery = astChild(cte, 'this');
    let columns = cteQuery ? analyzeAstQuery(cteQuery, context, undefined, ctes) : [];
    const explicitColumns = cte.aliasColumns;
    if (explicitColumns.length > 0) {
      columns = explicitColumns.map((name, index) => renameVirtualColumn(name, columns[index], context.dialect));
    }
    const name = cte.alias;
    if (name) {
      ctes.set(normalizeQualifiedName(name, context.dialect), {
        name,
        aliases: [normalizeQualifiedName(name, context.dialect)],
        columns,
        unresolved: false,
      });
    }
  }

  const fromNode = astChild(query, 'from');
  const firstRelation = fromNode ? astChild(fromNode, 'this') : undefined;
  if (firstRelation) {
    scope.relations.push(bindAstRelation(firstRelation, scope, ctes, context));
  }
  for (const join of astChildren(query, 'joins')) {
    const relationNode = astChild(join, 'this');
    if (!relationNode) continue;
    const leftRelations = [...scope.relations];
    const binding = bindAstRelation(relationNode, scope, ctes, context);
    scope.relations.push(binding);
    if (context.validate) validateAstUsing(join, leftRelations, binding, context);
  }
  for (const lateral of astChildren(query, 'laterals')) {
    scope.relations.push(bindAstRelation(lateral, scope, ctes, context));
  }

  const projections = astChildren(query, 'expressions');
  for (const projection of projections) {
    if (projection.alias) {
      scope.projectionAliases.add(normalizeBareIdentifier(projection.alias, context.dialect));
    }
  }
  if (context.validate) {
    for (const projection of projections) validateAstExpression(projection, scope, ctes, context);
    for (const join of astChildren(query, 'joins')) {
      const on = astChild(join, 'on');
      if (on) validateAstExpression(on, scope, ctes, context);
    }
    for (const key of ['where', 'group', 'having', 'qualify', 'order', 'sort', 'cluster'] as const) {
      const clause = astChild(query, key);
      if (clause) validateAstExpression(clause, scope, ctes, context);
    }
  } else {
    for (const projection of projections) collectAstReferences(projection, context);
    for (const key of ['where', 'group', 'having', 'qualify', 'order', 'sort', 'cluster'] as const) {
      const clause = astChild(query, key);
      if (clause) collectAstReferences(clause, context);
    }
  }
  return deriveAstProjectionColumns(projections, scope, context);
}

function astQueryStart(text: string, firstNodeStart: number): number {
  const prefix = text.slice(0, firstNodeStart);
  let start = 0;
  for (const match of prefix.matchAll(/\bSELECT\b/giu)) {
    start = match.index;
  }
  return start;
}

function bindAstRelation(
  relation: SqlAstNode,
  scope: AstScope,
  ctes: ReadonlyMap<string, RelationBinding>,
  context: AstModelContext,
): RelationBinding {
  if (relation.role === 'subquery') {
    const query = astChild(relation, 'this');
    const columns = query ? analyzeAstQuery(query, context, scope, ctes) : [];
    return astDerivedBinding(relation, columns, context.dialect);
  }
  if (relation.role === 'lateral') {
    const source = astChild(relation, 'this');
    return bindAstExpansion(source ?? relation, relation, scope, ctes, context);
  }
  if (relation.role === 'unnest' || relation.role === 'function') {
    return bindAstExpansion(relation, relation, scope, ctes, context);
  }
  if (relation.role !== 'table') {
    return astDerivedBinding(relation, [], context.dialect, true);
  }

  const tableExpression = astChild(relation, 'this');
  if (tableExpression && (tableExpression.role === 'function' || tableExpression.role === 'unnest')) {
    return bindAstExpansion(tableExpression, relation, scope, ctes, context);
  }
  const name = astTableName(relation);
  const dynamic = overlapsAny(astNameSpan(relation), context.placeholderRanges);
  const aliases = astRelationAliases(relation, name, context.dialect, dynamic);
  if (dynamic) {
    return { name: relation.alias || name, aliases, columns: [], unresolved: true, dynamic: true };
  }

  const collection = bindImpalaCollectionRelation(relation, scope, context);
  if (collection) return collection;
  const cte = ctes.get(normalizeQualifiedName(name, context.dialect));
  if (cte) {
    return { name: relation.alias || cte.name, aliases, columns: cte.columns, unresolved: false };
  }
  const resolution = resolveSchemaTable(context.snapshot, name, context.dialect);
  if (context.validate && resolution.status !== 'found') {
    appendAstIssue(context, astChild(relation, 'this') ?? relation,
      resolution.status === 'ambiguous' ? 'ambiguous-table' : 'unknown-table',
      resolution.status === 'ambiguous'
        ? `Table reference ${name} is ambiguous in the configured schema.`
        : `Unknown table ${name}.`);
  }
  return {
    name: relation.alias || name,
    aliases,
    columns: resolution.table?.columns ?? [],
    unresolved: resolution.status !== 'found',
  };
}

function bindImpalaCollectionRelation(
  relation: SqlAstNode,
  scope: AstScope,
  context: AstModelContext,
): RelationBinding | undefined {
  if (context.dialect !== 'impala') return undefined;
  const db = astChild(relation, 'db')?.name;
  const name = astChild(relation, 'this')?.name ?? relation.name;
  if (!db || !name) return undefined;
  const source = scope.relations.find((binding) => bindingMatchesQualifier(binding, db, context.dialect));
  const sourceColumn = source && findColumn(source.columns, name, context.dialect);
  if (!sourceColumn) return undefined;
  const dataType = columnDataType(sourceColumn, context.dialect);
  let columns: SchemaColumn[] = [];
  if (dataType.kind === 'array') {
    columns = [virtualColumn('item', dataTypeFamily(dataType.elementType), '', dataType.elementType)];
  } else if (dataType.kind === 'map') {
    columns = [
      virtualColumn('key', dataTypeFamily(dataType.keyType), '', dataType.keyType),
      virtualColumn('value', dataTypeFamily(dataType.valueType), '', dataType.valueType),
    ];
  } else {
    return undefined;
  }
  const alias = relation.alias || name;
  return {
    name: alias,
    aliases: [normalizeQualifiedName(alias, context.dialect)],
    columns,
    unresolved: false,
  };
}

function bindAstExpansion(
  source: SqlAstNode,
  relation: SqlAstNode,
  scope: AstScope,
  ctes: ReadonlyMap<string, RelationBinding>,
  context: AstModelContext,
): RelationBinding {
  if (context.validate) validateAstExpression(source, scope, ctes, context);
  else collectAstReferences(source, context);
  const functionName = normalizeBareIdentifier(source.name || source.kind, context.dialect).replace(/^!/u, '');
  const inputs = astExpressionArguments(source);
  const inputType = inputs[0] ? inferAstExpressionType(inputs[0], scope, context) : UNKNOWN_DATA_TYPE;
  let columns: SchemaColumn[] = [];
  if (functionName === 'posexplode' || functionName === 'posexplode_outer') {
    columns.push(virtualColumn('pos', 'number'));
    if (inputType.kind === 'array') {
      columns.push(virtualColumn('col', dataTypeFamily(inputType.elementType), '', inputType.elementType));
    } else if (inputType.kind === 'map') {
      columns.push(
        virtualColumn('key', dataTypeFamily(inputType.keyType), '', inputType.keyType),
        virtualColumn('value', dataTypeFamily(inputType.valueType), '', inputType.valueType),
      );
    }
  } else if (functionName === 'explode' || functionName === 'explode_outer' || functionName === 'unnest') {
    if (inputType.kind === 'array') {
      columns.push(virtualColumn('col', dataTypeFamily(inputType.elementType), '', inputType.elementType));
    } else if (inputType.kind === 'map') {
      columns.push(
        virtualColumn('key', dataTypeFamily(inputType.keyType), '', inputType.keyType),
        virtualColumn('value', dataTypeFamily(inputType.valueType), '', inputType.valueType),
      );
    } else {
      columns.push(virtualColumn('col'));
    }
  } else if (source.kind === 'jsonTable') {
    const schema = astChild(source, 'schema');
    columns = schema ? astChildren(schema, 'expressions').map((column) => {
      const dataType = astChild(column, 'kind');
      const type = dataType ? astDataTypeText(dataType) : '';
      return virtualColumn(column.name, typeFamily(type), type, parseSqlDataType(type, context.dialect));
    }) : [];
  }

  const explicit = relation.aliasColumns.length > 0 ? relation.aliasColumns : source.aliasColumns;
  if (explicit.length > 0) {
    columns = explicit.map((name, index) => renameVirtualColumn(name, columns[index], context.dialect));
  } else if (columns.length === 0) {
    columns = [virtualColumn(source.outputName || source.name || 'col')];
  }
  const alias = relation.alias || source.alias || source.name || source.kind;
  return {
    name: alias,
    aliases: alias ? [normalizeQualifiedName(alias, context.dialect)] : [],
    columns,
    unresolved: false,
  };
}

function validateAstUsing(
  join: SqlAstNode,
  leftRelations: readonly RelationBinding[],
  right: RelationBinding,
  context: AstModelContext,
): void {
  for (const identifier of astChildren(join, 'using')) {
    const leftHas = leftRelations.some((binding) => binding.unresolved
      || Boolean(findColumn(binding.columns, identifier.name, context.dialect)));
    const rightHas = right.unresolved || Boolean(findColumn(right.columns, identifier.name, context.dialect));
    if (!leftHas || !rightHas) {
      appendAstIssue(context, identifier, 'unknown-column',
        `USING column ${identifier.name} must exist on both sides of the join.`);
    }
  }
}

function validateAstExpression(
  node: SqlAstNode,
  scope: AstScope,
  ctes: ReadonlyMap<string, RelationBinding>,
  context: AstModelContext,
): void {
  if (overlapsAny({ start: node.start, end: node.end }, context.placeholderRanges)) return;
  if (node.role === 'select' || node.role === 'set-operation') {
    analyzeAstQuery(node, context, scope, ctes);
    return;
  }
  if (node.role === 'column') {
    context.references.push(astIdentifierReference(node));
    validateAstColumn(node, scope, context);
    return;
  }
  if (node.role === 'function') {
    const name = node.name;
    if (node.kind === 'anonymous' && name) {
      context.references.push({ text: name, parts: [name], start: node.start, end: node.end, isFunction: true });
      if (!context.functions.has(normalizeQualifiedName(name, context.dialect))) {
        appendAstIssue(context, node, 'unknown-function',
          `Unknown function ${name}. Add it to aiopsSqlJson.udfs if it is user-defined.`, 'warning');
      }
    }
  }
  if (node.kind === 'dot') validateAstNestedField(node, scope, context);
  forEachAstChild(node, (child) => validateAstExpression(child, scope, ctes, context));
}

function validateAstColumn(node: SqlAstNode, scope: AstScope, context: AstModelContext): void {
  const name = node.name;
  const qualifier = astColumnQualifier(node);
  if (name === '*' && !qualifier) return;
  const resolution = resolveAstColumn(scope, qualifier, name, context.dialect);
  if (resolution.status === 'found' || resolution.status === 'unresolved') return;
  if (resolution.status === 'ambiguous') {
    appendAstIssue(context, node, 'ambiguous-column',
      `Column ${qualifier ? `${qualifier}.` : ''}${name} is ambiguous; qualify it with a table alias.`);
  } else if (resolution.status === 'missing-qualifier') {
    const qualifierNode = astChild(node, 'table') ?? astChild(node, 'db') ?? node;
    appendAstIssue(context, qualifierNode, 'unknown-qualifier', `Unknown table or alias ${qualifier}.`);
  } else if (name !== '*') {
    appendAstIssue(context, node, 'unknown-column',
      `Unknown column ${qualifier ? `${qualifier}.` : ''}${name}.`);
  }
}

function resolveAstColumn(
  scope: AstScope | undefined,
  qualifier: string,
  name: string,
  dialect: SqlDialect,
): AstColumnResolution {
  for (let current = scope; current; current = current.parent) {
    if (qualifier) {
      const binding = current.relations.find((candidate) => bindingMatchesQualifier(candidate, qualifier, dialect));
      if (binding) {
        if (binding.unresolved) return { status: 'unresolved' };
        if (name === '*') return { status: 'found' };
        const column = findColumn(binding.columns, name, dialect);
        return column ? { status: 'found', column } : { status: 'missing-column' };
      }
      if (name !== '*') {
        const baseMatches = current.relations.flatMap((candidate) => {
          const column = candidate.unresolved ? undefined : findColumn(candidate.columns, qualifier, dialect);
          return column ? [column] : [];
        });
        if (baseMatches.length === 1) {
          const nested = fieldDataType(columnDataType(baseMatches[0]!, dialect), name, dialect);
          return nested
            ? { status: 'found', column: virtualColumn(name, dataTypeFamily(nested), '', nested) }
            : { status: 'missing-column' };
        }
        if (baseMatches.length > 1) return { status: 'ambiguous' };
      }
      continue;
    }
    if (current.projectionAliases.has(normalizeBareIdentifier(name, dialect))) return { status: 'found' };
    const matches = current.relations.flatMap((binding) => {
      const column = binding.unresolved ? undefined : findColumn(binding.columns, name, dialect);
      return column ? [column] : [];
    });
    if (matches.length === 1) return { status: 'found', column: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous' };
    if (current.relations.some((binding) => binding.unresolved)) return { status: 'unresolved' };
  }
  return { status: qualifier ? 'missing-qualifier' : 'missing-column' };
}

function validateAstNestedField(node: SqlAstNode, scope: AstScope, context: AstModelContext): void {
  const base = astChild(node, 'this');
  const field = astChild(node, 'expression');
  if (!base || !field?.name) return;
  const dataType = inferAstExpressionType(base, scope, context);
  if (dataType.kind !== 'unknown' && !fieldDataType(dataType, field.name, context.dialect)) {
    appendAstIssue(context, field, 'unknown-column', `Unknown column ${field.name}.`);
  }
}

function deriveAstProjectionColumns(
  projections: readonly SqlAstNode[],
  scope: AstScope,
  context: AstModelContext,
): SchemaColumn[] {
  const columns: SchemaColumn[] = [];
  for (const projection of projections) {
    const expression = projection.role === 'alias' ? astChild(projection, 'this') ?? projection : projection;
    if (expression.role === 'column' && expression.name === '*') {
      const qualifier = astColumnQualifier(expression);
      const relations = qualifier
        ? scope.relations.filter((binding) => bindingMatchesQualifier(binding, qualifier, context.dialect))
        : scope.relations;
      columns.push(...relations.flatMap((binding) => binding.columns));
      continue;
    }
    const name = projection.alias || projection.outputName || expression.outputName || expression.name;
    if (!name) continue;
    const dataType = inferAstExpressionType(expression, scope, context);
    columns.push(renameVirtualColumn(name, virtualColumn(name, dataTypeFamily(dataType), '', dataType), context.dialect));
  }
  return columns;
}

function inferAstExpressionType(node: SqlAstNode, scope: AstScope | undefined, context: AstModelContext): SqlDataType {
  if (node.role === 'alias') {
    const inner = astChild(node, 'this');
    return inner ? inferAstExpressionType(inner, scope, context) : UNKNOWN_DATA_TYPE;
  }
  if (node.role === 'column') {
    return resolveAstColumn(scope, astColumnQualifier(node), node.name, context.dialect).column
      ? columnDataType(resolveAstColumn(scope, astColumnQualifier(node), node.name, context.dialect).column!, context.dialect)
      : UNKNOWN_DATA_TYPE;
  }
  if (node.role === 'literal') {
    if (node.args.isString === true) return dataTypeFromFamily('string');
    return /^[-+]?\d/u.test(node.name) ? dataTypeFromFamily('number') : UNKNOWN_DATA_TYPE;
  }
  if (node.kind === 'boolean') return dataTypeFromFamily('boolean');
  if (node.kind === 'cast' || node.kind === 'tryCast') {
    const target = astChild(node, 'to');
    return target ? parseSqlDataType(astDataTypeText(target), context.dialect) : UNKNOWN_DATA_TYPE;
  }
  if (node.kind === 'dot') {
    const base = astChild(node, 'this');
    const field = astChild(node, 'expression');
    const baseType = base ? inferAstExpressionType(base, scope, context) : UNKNOWN_DATA_TYPE;
    return field?.name ? fieldDataType(baseType, field.name, context.dialect) ?? UNKNOWN_DATA_TYPE : UNKNOWN_DATA_TYPE;
  }
  const normalizedFunction = normalizeBareIdentifier(node.name || node.kind, context.dialect).replace(/^!/u, '');
  const args = astExpressionArguments(node);
  if (['count', 'row_number', 'rank', 'dense_rank', 'size', 'cardinality'].includes(normalizedFunction)) {
    return dataTypeFromFamily('number');
  }
  if (['sum', 'avg', 'max', 'min'].includes(normalizedFunction) && args[0]) {
    return inferAstExpressionType(args[0], scope, context);
  }
  if (normalizedFunction === 'from_json' && args[1]?.role === 'literal') {
    return parseSqlDataType(args[1].name, context.dialect);
  }
  if (normalizedFunction === 'struct') {
    return {
      kind: 'struct',
      fields: args.map((argument, index) => {
        const dataType = inferAstExpressionType(argument, scope, context);
        const name = argument.outputName || argument.name || `col${index + 1}`;
        return virtualColumn(name, dataTypeFamily(dataType), '', dataType);
      }),
    };
  }
  if (normalizedFunction === 'named_struct') {
    const fields: SchemaColumn[] = [];
    for (let index = 0; index + 1 < args.length; index += 2) {
      const name = args[index]?.role === 'literal' ? args[index]!.name : '';
      const value = args[index + 1];
      if (!name || !value) return UNKNOWN_DATA_TYPE;
      const dataType = inferAstExpressionType(value, scope, context);
      fields.push(virtualColumn(name, dataTypeFamily(dataType), '', dataType));
    }
    return { kind: 'struct', fields };
  }
  if (normalizedFunction === 'split') return { kind: 'array', elementType: dataTypeFromFamily('string') };
  if (normalizedFunction === 'array') {
    return { kind: 'array', elementType: args[0] ? inferAstExpressionType(args[0], scope, context) : UNKNOWN_DATA_TYPE };
  }
  const source = context.text.slice(node.start, node.end);
  const fallback = inferExpressionDataType(source, visibleAstRelations(scope), context.dialect);
  if (fallback.kind !== 'unknown') return fallback;
  if (['add', 'sub', 'mul', 'div', 'intDiv', 'mod'].includes(node.kind)) return dataTypeFromFamily('number');
  if (['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'is', 'in', 'between'].includes(node.kind)) {
    return dataTypeFromFamily('boolean');
  }
  return UNKNOWN_DATA_TYPE;
}

function analyzeAstInsert(
  insert: SqlAstNode,
  context: AstModelContext,
  ctes: ReadonlyMap<string, RelationBinding>,
): SchemaColumn[] {
  const targetNode = astChild(insert, 'this');
  const targetTable = targetNode?.role === 'schema' ? astChild(targetNode, 'this') : targetNode;
  const targetName = targetTable ? astTableName(targetTable) : '';
  const target = targetName ? resolveSchemaTable(context.snapshot, targetName, context.dialect) : { status: 'missing' as const };
  if (context.validate && targetName && target.status !== 'found') {
    appendAstIssue(context, targetTable ?? insert,
      target.status === 'ambiguous' ? 'ambiguous-table' : 'unknown-table',
      target.status === 'ambiguous' ? `Table reference ${targetName} is ambiguous in the configured schema.` : `Unknown table ${targetName}.`);
  }
  const source = astChild(insert, 'expression');
  const sourceColumns = source ? analyzeAstQuery(source, context, undefined, ctes) : [];
  if (!context.validate || target.status !== 'found' || !target.table) return sourceColumns;

  const explicit = targetNode?.role === 'schema' ? astChildren(targetNode, 'expressions') : [];
  const shape = extractInsertShape(context.text, context.dialect);
  const targetColumns = explicit.length > 0
    ? explicit.flatMap((identifier) => {
        const column = findColumn(target.table!.columns, identifier.name, context.dialect);
        if (!column) {
          appendAstIssue(context, identifier, 'unknown-column', `Unknown target column ${identifier.name}.`);
          return [];
        }
        return [column];
      })
    : target.table.columns.filter((column) => !shape.staticPartitionColumns.includes(column.normalizedName));
  const expectedCount = explicit.length > 0 ? explicit.length : targetColumns.length;
  if (sourceColumns.length > 0 && sourceColumns.length !== expectedCount) {
    appendAstIssue(context, targetTable, 'insert-column-count',
      `INSERT writes ${sourceColumns.length} value(s) into ${expectedCount} target column(s).`);
  }
  for (let index = 0; index < Math.min(targetColumns.length, sourceColumns.length); index += 1) {
    const expected = targetColumns[index]!;
    const actual = sourceColumns[index]!;
    if (!areTypesCompatible(expected.typeFamily, actual.typeFamily)) {
      appendAstIssue(context, source ?? insert, 'incompatible-type',
        `Cannot assign ${actual.typeFamily} value to ${expected.name} (${expected.type || expected.typeFamily}).`);
    }
  }
  return sourceColumns;
}

function analyzeAstUpdate(
  update: SqlAstNode,
  context: AstModelContext,
  ctes: ReadonlyMap<string, RelationBinding>,
): void {
  const table = astChild(update, 'this');
  if (!table) return;
  const scope: AstScope = {
    start: update.start,
    end: update.end,
    depth: 0,
    relations: [],
    projectionAliases: new Set(),
  };
  context.scopes.push(scope);
  scope.relations.push(bindAstRelation(table, scope, ctes, context));
  for (const assignment of astChildren(update, 'expressions')) {
    const target = astChild(assignment, 'this');
    const value = astChild(assignment, 'expression');
    if (!target || !value) continue;
    if (context.validate) {
      validateAstExpression(target, scope, ctes, context);
      validateAstExpression(value, scope, ctes, context);
      const expected = target.role === 'column'
        ? resolveAstColumn(scope, astColumnQualifier(target), target.name, context.dialect).column
        : undefined;
      const actualType = inferAstExpressionType(value, scope, context);
      if (expected && !areTypesCompatible(expected.typeFamily, dataTypeFamily(actualType))) {
        appendAstIssue(context, value, 'incompatible-type',
          `Cannot assign ${dataTypeFamily(actualType)} value to ${expected.name} (${expected.type || expected.typeFamily}).`);
      }
    }
  }
  const where = astChild(update, 'where');
  if (where && context.validate) validateAstExpression(where, scope, ctes, context);
}

function deriveAstValuesColumns(node: SqlAstNode, context: AstModelContext, scope: AstScope | undefined): SchemaColumn[] {
  if (node.kind !== 'values') return [];
  const firstRow = astChildren(node, 'expressions')[0];
  const values = firstRow ? astChildren(firstRow, 'expressions') : [];
  return values.map((value, index) => {
    const dataType = inferAstExpressionType(value, scope, context);
    return virtualColumn(`col${index + 1}`, dataTypeFamily(dataType), '', dataType);
  });
}

function collectAstReferences(node: SqlAstNode, context: AstModelContext): void {
  if (overlapsAny({ start: node.start, end: node.end }, context.placeholderRanges)) return;
  if (node.role === 'column') {
    context.references.push(astIdentifierReference(node));
    return;
  }
  forEachAstChild(node, (child) => collectAstReferences(child, context));
}

function forEachAstChild(node: SqlAstNode, visit: (child: SqlAstNode) => void): void {
  for (const value of Object.values(node.args)) {
    if (isSqlAstNode(value)) visit(value);
    else if (Array.isArray(value)) {
      for (const child of value) if (isSqlAstNode(child)) visit(child);
    }
  }
}

function astExpressionArguments(node: SqlAstNode): readonly SqlAstNode[] {
  const expressions = astChildren(node, 'expressions');
  if (expressions.length > 0) return expressions;
  const thisNode = astChild(node, 'this');
  return thisNode ? [thisNode] : [];
}

function astIdentifierReference(node: SqlAstNode): IdentifierReference {
  const qualifier = astColumnQualifier(node);
  const text = qualifier ? `${qualifier}.${node.name}` : node.name;
  return {
    text,
    parts: qualifier ? [...splitQualifiedName(qualifier).map((part) => part.text), node.name] : [node.name],
    start: node.start,
    end: node.end,
    isFunction: false,
  };
}

function astColumnQualifier(node: SqlAstNode): string {
  return ['catalog', 'db', 'table'].flatMap((key) => {
    const part = astChild(node, key);
    return part?.name ? [part.name] : [];
  }).join('.');
}

function astTableName(node: SqlAstNode): string {
  return ['catalog', 'db', 'this'].flatMap((key) => {
    const part = astChild(node, key);
    return part?.name ? [part.name] : [];
  }).join('.') || node.name;
}

function astRelationAliases(
  relation: SqlAstNode,
  name: string,
  dialect: SqlDialect,
  dynamic: boolean,
): string[] {
  const aliases = [relation.alias, dynamic ? '' : name, dynamic ? '' : name.split('.').at(-1) ?? '']
    .filter(Boolean)
    .map((value) => normalizeQualifiedName(value, dialect));
  return [...new Set(aliases)];
}

function astDerivedBinding(
  relation: SqlAstNode,
  columns: readonly SchemaColumn[],
  dialect: SqlDialect,
  unresolved = false,
): RelationBinding {
  const name = relation.alias || relation.outputName || relation.name;
  return {
    name,
    aliases: name ? [normalizeQualifiedName(name, dialect)] : [],
    columns,
    unresolved,
  };
}

function astNameSpan(node: SqlAstNode): { start: number; end: number } {
  const parts = ['catalog', 'db', 'this'].flatMap((key) => {
    const child = astChild(node, key);
    return child ? [{ start: child.start, end: child.end }] : [];
  });
  return parts.length > 0
    ? { start: Math.min(...parts.map((part) => part.start)), end: Math.max(...parts.map((part) => part.end)) }
    : { start: node.start, end: node.end };
}

function astDataTypeText(node: SqlAstNode): string {
  const nested = astChildren(node, 'expressions');
  const base = node.name || astPrimitiveString(node.args.this);
  if (nested.length === 0) return base;
  const delimiter = base.toLocaleLowerCase() === 'row' ? ['(', ')'] : ['<', '>'];
  return `${base}${delimiter[0]}${nested.map(astDataTypeText).join(',')}${delimiter[1]}`;
}

function astPrimitiveString(value: SqlAstValue): string {
  return typeof value === 'string' ? value : '';
}

function renameVirtualColumn(name: string, source: SchemaColumn | undefined, dialect: SqlDialect): SchemaColumn {
  const quoted = isQuotedIdentifier(name);
  const visible = unquoteIdentifier(name);
  const dataType = source?.dataType ?? UNKNOWN_DATA_TYPE;
  return {
    name: visible,
    normalizedName: normalizeIdentifier(visible, quoted, dialect),
    type: source?.type ?? '',
    typeFamily: source?.typeFamily ?? dataTypeFamily(dataType),
    dataType,
    start: source?.start ?? 0,
    end: source?.end ?? 0,
  };
}

function visibleAstRelations(scope: AstScope | undefined): RelationBinding[] {
  const result: RelationBinding[] = [];
  for (let current = scope; current; current = current.parent) result.push(...current.relations);
  return result;
}

function appendAstIssue(
  context: AstModelContext,
  node: SqlAstNode | undefined,
  code: string,
  message: string,
  severity?: 'error' | 'warning',
): void {
  if (!node) return;
  context.issues.push({
    start: node.start,
    end: Math.max(node.end, node.start + 1),
    message,
    code,
    ...(severity ? { severity } : {}),
  });
}

function createScopes(entities: readonly EntityContext[], textLength: number): MutableScope[] {
  const scopes = new Map<string, MutableScope>();
  for (const entity of flattenEntities(entities)) {
    const statement = entity.belongStmt;
    const start = Math.max(0, statement.position.startIndex);
    const end = Math.min(textLength, statement.position.endIndex + 1);
    const key = `${start}:${end}:${statement.scopeDepth}`;
    if (!scopes.has(key)) {
      scopes.set(key, {
        start,
        end,
        depth: statement.scopeDepth,
        relations: [],
        projectionAliases: new Set<string>(),
      });
    }
  }
  if (scopes.size === 0) {
    scopes.set(`0:${textLength}:0`, {
      start: 0,
      end: textLength,
      depth: 0,
      relations: [],
      projectionAliases: new Set<string>(),
    });
  }
  return [...scopes.values()];
}

function bindingForEntity(
  entity: EntityContext,
  text: string,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  ctes: ReadonlyMap<string, CteDefinition>,
  placeholders: readonly RegExp[],
  placeholderRanges: readonly { start: number; end: number }[],
): RelationBinding {
  const dynamic = overlapsAny(entityRange(entity), placeholderRanges);
  const originalName = text.slice(entity.position.startIndex, entity.position.endIndex + 1);
  const alias = entity._alias?.text;
  const aliases = [alias, dynamic ? undefined : entity.text, dynamic ? undefined : splitQualifiedName(entity.text).at(-1)?.text]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeQualifiedName(value, dialect));
  if (dynamic) {
    return {
      name: alias ?? originalName,
      aliases,
      columns: [],
      unresolved: true,
      dynamic: true,
    };
  }
  if (isExpressionTable(entity)) {
    return {
      name: alias ?? entity.text,
      aliases,
      columns: columnsFromRelatedEntities(entity.relatedEntities ?? [], dialect, snapshot, ctes, placeholders),
      unresolved: false,
    };
  }
  const cte = ctes.get(normalizeQualifiedName(entity.text, dialect));
  if (cte) {
    return { name: alias ?? cte.name, aliases, columns: cte.columns, unresolved: false };
  }
  const resolution = resolveSchemaTable(snapshot, entity.text, dialect);
  return {
    name: alias ?? entity.text,
    aliases,
    columns: resolution.table?.columns ?? [],
    unresolved: resolution.status !== 'found',
  };
}

function bindingForLateralView(
  view: SemanticLateralView,
  text: string,
  sourceBindings: readonly RelationBinding[],
  dialect: SqlDialect,
): RelationBinding {
  const input = inferExpressionDataType(
    text.slice(view.argumentStart, view.argumentEnd),
    sourceBindings,
    dialect,
  );
  const functionName = normalizeBareIdentifier(view.functionName, dialect).replace(/^!/u, '');
  const outputTypes: SqlDataType[] = [];
  const defaultNames: string[] = [];
  if (functionName === 'posexplode' || functionName === 'posexplode_outer') {
    outputTypes.push(dataTypeFromFamily('number'));
    defaultNames.push('pos');
    if (input.kind === 'array') {
      outputTypes.push(input.elementType);
      defaultNames.push('col');
    } else if (input.kind === 'map') {
      outputTypes.push(input.keyType, input.valueType);
      defaultNames.push('key', 'value');
    }
  } else if (functionName === 'explode' || functionName === 'explode_outer') {
    if (input.kind === 'array') {
      outputTypes.push(input.elementType);
      defaultNames.push('col');
    } else if (input.kind === 'map') {
      outputTypes.push(input.keyType, input.valueType);
      defaultNames.push('key', 'value');
    }
  }
  const count = Math.max(outputTypes.length, view.outputAliases.length, defaultNames.length);
  const columns = Array.from({ length: count }, (_, index) => {
    const name = view.outputAliases[index] ?? defaultNames[index] ?? `col${index + 1}`;
    const dataType = outputTypes[index] ?? UNKNOWN_DATA_TYPE;
    return virtualColumn(name, dataTypeFamily(dataType), '', dataType);
  });
  const name = view.tableAlias || view.functionName;
  return {
    name,
    aliases: view.tableAlias ? [normalizeQualifiedName(view.tableAlias, dialect)] : [],
    columns,
    unresolved: false,
  };
}

function referenceFromSemantic(reference: SemanticReference): IdentifierReference {
  return {
    text: reference.text,
    parts: splitQualifiedName(reference.text).map((part) => (
      part.quoted ? quoteIdentifierPart(part.text) : part.text
    )),
    start: reference.start,
    end: reference.end,
    isFunction: reference.kind === 'function',
  };
}

function quoteIdentifierPart(value: string): string {
  return `\`${value.replace(/`/gu, '``')}\``;
}

function columnsFromRelatedEntities(
  entities: readonly EntityContext[],
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  ctes: ReadonlyMap<string, CteDefinition>,
  placeholders: readonly RegExp[],
): SchemaColumn[] {
  const queryResult = flattenEntities(entities).find((entity) => entity.entityContextType === 'queryResult');
  if (!queryResult || !isCommonEntity(queryResult)) {
    return [];
  }
  return columnsFromQueryResult(queryResult, dialect, snapshot, ctes, placeholders);
}

function columnsFromQueryResult(
  queryResult: CommonEntityContext,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  ctes: ReadonlyMap<string, CteDefinition>,
  placeholders: readonly RegExp[],
): SchemaColumn[] {
  const sourceBindings = (queryResult.relatedEntities ?? [])
    .filter((entity) => entity.entityContextType === 'table')
    .map((entity) => bindingForEntity(
      entity,
      entity.belongStmt.text,
      dialect,
      snapshot,
      ctes,
      placeholders,
      [],
    ));
  const result: SchemaColumn[] = [];
  for (const column of queryResult.columns ?? []) {
    const alias = column._alias?.text;
    const raw = column.text.trim();
    if (column.declareType === 1 || raw === '*' || raw.endsWith('.*')) {
      const qualifier = raw === '*' ? undefined : raw.slice(0, -2);
      const sources = qualifier
        ? sourceBindings.filter((binding) => bindingMatchesQualifier(binding, qualifier, dialect))
        : sourceBindings;
      result.push(...sources.flatMap((binding) => binding.columns));
      continue;
    }
    if (alias) {
      const dataType = inferExpressionDataType(raw, sourceBindings, dialect);
      result.push(virtualColumn(alias, dataTypeFamily(dataType), '', dataType));
      continue;
    }
    if (!/[()+*/%<>=]/u.test(raw)) {
      const name = splitQualifiedName(raw).at(-1)?.text ?? raw;
      const sourceColumn = resolveColumnFromBindings(sourceBindings, raw, dialect);
      result.push(sourceColumn ?? virtualColumn(unquoteIdentifier(name)));
    } else {
      const fieldAccess = trailingFieldAccess(raw);
      if (fieldAccess) {
        const dataType = inferExpressionDataType(raw, sourceBindings, dialect);
        result.push(virtualColumn(unquoteIdentifier(fieldAccess.field), dataTypeFamily(dataType), '', dataType));
      }
    }
  }
  return deduplicateColumns(result);
}

function extractCtes(
  text: string,
  tokens: readonly SqlLexToken[],
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  placeholders: readonly RegExp[],
): Map<string, CteDefinition> {
  const result = new Map<string, CteDefinition>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenUpper(tokens[index]) !== 'WITH') {
      continue;
    }
    let cursor = index + 1;
    if (tokenUpper(tokens[cursor]) === 'RECURSIVE') {
      cursor += 1;
    }
    while (cursor < tokens.length) {
      const nameToken = tokens[cursor];
      if (!nameToken || !isIdentifierToken(nameToken, dialect)) {
        break;
      }
      const name = unquoteIdentifier(nameToken.text);
      cursor += 1;
      let explicitColumns: string[] = [];
      if (tokens[cursor]?.text === '(') {
        const close = findMatchingToken(tokens, cursor, '(', ')');
        if (close < 0 || tokenUpper(tokens[close + 1]) !== 'AS') {
          break;
        }
        explicitColumns = tokens.slice(cursor + 1, close)
          .filter((token) => isIdentifierToken(token, dialect))
          .map((token) => unquoteIdentifier(token.text));
        cursor = close + 1;
      }
      if (tokenUpper(tokens[cursor]) !== 'AS' || tokens[cursor + 1]?.text !== '(') {
        break;
      }
      const open = cursor + 1;
      const close = findMatchingToken(tokens, open, '(', ')');
      if (close < 0) {
        break;
      }
      const queryStart = tokens[open]!.end;
      const queryEnd = tokens[close]!.start;
      const queryText = text.slice(queryStart, queryEnd);
      let columns = deriveQueryColumns(queryText, dialect, snapshot, result, placeholders);
      if (explicitColumns.length > 0) {
        columns = explicitColumns.map((columnName, columnIndex) => {
          const inferred = columns[columnIndex];
          return virtualColumn(columnName, inferred?.typeFamily ?? 'unknown', inferred?.type ?? '');
        });
      }
      const definition: CteDefinition = {
        name,
        normalizedName: normalizeQualifiedName(name, dialect),
        columns,
        declarationStart: nameToken.start,
        declarationEnd: nameToken.end,
      };
      result.set(definition.normalizedName, definition);
      cursor = close + 1;
      if (tokens[cursor]?.text !== ',') {
        break;
      }
      cursor += 1;
    }
  }
  return result;
}

function deriveQueryColumns(
  text: string,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  ctes: ReadonlyMap<string, CteDefinition>,
  placeholders: readonly RegExp[],
): SchemaColumn[] {
  const ast = parseSqlAst(text, dialect, placeholders);
  if (ast?.statements[0]) {
    return deriveAstStatementColumns(text, dialect, snapshot, placeholders, ast.statements[0]);
  }
  const entities = getSqlEntities(text, dialect, placeholders);
  const results = flattenEntities(entities)
    .filter((entity): entity is CommonEntityContext => entity.entityContextType === 'queryResult' && isCommonEntity(entity))
    .sort((left, right) => left.belongStmt.scopeDepth - right.belongStmt.scopeDepth);
  const result = results[0];
  return result ? columnsFromQueryResult(result, dialect, snapshot, ctes, placeholders) : [];
}

function deriveAstStatementColumns(
  text: string,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  placeholders: readonly RegExp[],
  statement: SqlAstNode,
): SchemaColumn[] {
  const context: AstModelContext = {
    text,
    dialect,
    snapshot,
    placeholderRanges: findPlaceholderRanges(text, placeholders),
    functions: new Set(),
    validate: false,
    scopes: [],
    references: [],
    issues: [],
  };
  return analyzeAstStatement(statement, context, new Map());
}

function validateReferences(
  references: readonly IdentifierReference[],
  scopes: readonly MutableScope[],
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  udfs: readonly string[],
  issues: SqlSemanticIssue[],
): void {
  const catalog = getSqlCatalog(dialect);
  const functions = new Set([
    ...catalog.functions.map((name) => normalizeQualifiedName(name, dialect)),
    ...udfs.map((name) => normalizeQualifiedName(name, dialect)),
  ]);
  for (const reference of references) {
    if (reference.isFunction) {
      if (!functions.has(normalizeQualifiedName(reference.text, dialect))) {
        issues.push({
          start: reference.start,
          end: reference.end,
          message: `Unknown function ${reference.text}. Add it to aiopsSqlJson.udfs if it is user-defined.`,
          code: 'unknown-function',
          severity: 'warning',
        });
      }
      continue;
    }

    const availableScopes = containingScopes(scopes, reference.start);
    if (availableScopes.length === 0) {
      continue;
    }
    if (reference.parts.length > 1) {
      const resolution = resolveMultipartReference(reference.parts, availableScopes, dialect);
      if (resolution === 'missing-qualifier') {
        const qualifier = reference.parts.slice(0, -1).join('.');
        const columnName = reference.parts.at(-1)!;
        issues.push({
          start: reference.start,
          end: reference.end - columnName.length - 1,
          message: `Unknown table or alias ${qualifier}.`,
          code: 'unknown-qualifier',
        });
      } else if (resolution === 'missing-column') {
        issues.push({
          start: reference.start,
          end: reference.end,
          message: `Unknown column ${reference.text}.`,
          code: 'unknown-column',
        });
      }
      continue;
    }

    const name = reference.parts[0]!;
    const normalized = normalizeBareIdentifier(name, dialect);
    if (availableScopes.some((scope) => scope.projectionAliases.has(normalized))) {
      continue;
    }
    let bindings: RelationBinding[] = [];
    let unresolved = false;
    for (const scope of availableScopes) {
      bindings = scope.relations.filter((binding) => !binding.unresolved && Boolean(findColumn(binding.columns, name, dialect)));
      unresolved = scope.relations.some((binding) => binding.unresolved);
      if (bindings.length > 0 || unresolved) break;
    }
    if (bindings.length === 0 && !unresolved && snapshot.tables.length >= 0) {
      issues.push({
        start: reference.start,
        end: reference.end,
        message: `Unknown column ${reference.text}.`,
        code: 'unknown-column',
      });
    } else if (bindings.length > 1) {
      issues.push({
        start: reference.start,
        end: reference.end,
        message: `Column ${reference.text} is ambiguous; qualify it with a table alias.`,
        code: 'ambiguous-column',
      });
    }
  }
}

function resolveMultipartReference(
  parts: readonly string[],
  scopes: readonly MutableScope[],
  dialect: SqlDialect,
): 'found' | 'unresolved' | 'missing-column' | 'missing-qualifier' {
  for (const scope of scopes) {
    for (let split = parts.length - 1; split >= 1; split -= 1) {
      const qualifier = parts.slice(0, split).join('.');
      const binding = scope.relations.find((candidate) => bindingMatchesQualifier(candidate, qualifier, dialect));
      if (!binding) continue;
      if (binding.unresolved) return 'unresolved';
      const column = findColumn(binding.columns, parts[split]!, dialect);
      if (!column) return 'missing-column';
      return resolveNestedFields(columnDataType(column, dialect), parts.slice(split + 1), dialect)
        ? 'found'
        : 'missing-column';
    }

    const baseMatches = scope.relations.flatMap((binding) => {
      if (binding.unresolved) return [];
      const column = findColumn(binding.columns, parts[0]!, dialect);
      return column ? [column] : [];
    });
    if (baseMatches.length === 1) {
      return resolveNestedFields(columnDataType(baseMatches[0]!, dialect), parts.slice(1), dialect)
        ? 'found'
        : 'missing-column';
    }
    if (baseMatches.length > 1) return 'missing-column';
    if (scope.relations.some((binding) => binding.unresolved)) return 'unresolved';
  }
  return 'missing-qualifier';
}

function validateFieldAccesses(
  accesses: readonly SemanticFieldAccess[],
  text: string,
  scopes: readonly MutableScope[],
  dialect: SqlDialect,
  issues: SqlSemanticIssue[],
): void {
  for (const access of accesses) {
    const scope = smallestContainingScope(scopes, access.start);
    const dataType = inferExpressionDataType(
      text.slice(access.baseStart, access.baseEnd),
      scope?.relations ?? [],
      dialect,
    );
    if (dataType.kind === 'struct' && !findColumn(dataType.fields, access.field, dialect)) {
      issues.push({
        start: access.fieldStart,
        end: access.fieldEnd,
        message: `Unknown column ${text.slice(access.start, access.end)}.`,
        code: 'unknown-column',
      });
    }
  }
}

function validateInsertShapes(
  text: string,
  entities: readonly EntityContext[],
  scopes: readonly MutableScope[],
  dialect: SqlDialect,
  issues: SqlSemanticIssue[],
): void {
  const flat = flattenEntities(entities);
  const targets = flat.filter((entity) => (
    entity.entityContextType === 'table'
      && entity.belongStmt.stmtContextType === 'insertStmt'
  ));
  for (const target of targets) {
    const scope = smallestContainingScope(scopes, target.position.startIndex);
    const targetBinding = scope?.relations.find((binding) => bindingMatchesQualifier(binding, target.text, dialect));
    if (!targetBinding || targetBinding.unresolved) {
      continue;
    }
    const statementText = text.slice(target.belongStmt.position.startIndex, target.belongStmt.position.endIndex + 1);
    const selectEntities = flat.filter((entity): entity is CommonEntityContext => (
      entity.entityContextType === 'queryResult'
        && isCommonEntity(entity)
        && entity.belongStmt.rootStmt?.position.startIndex === target.belongStmt.position.startIndex
    ));
    const projection = selectEntities.at(-1)?.columns ?? [];
    if (projection.length === 0) {
      continue;
    }
    const insertShape = extractInsertShape(statementText, dialect);
    const targetSchemaColumns = insertShape.targetColumns.length > 0
      ? insertShape.targetColumns.flatMap((name) => {
          const column = targetBinding.columns.find((candidate) => candidate.normalizedName === name);
          return column ? [column] : [];
        })
      : targetBinding.columns.filter((column) => !insertShape.staticPartitionColumns.includes(column.normalizedName));
    const expectedCount = insertShape.targetColumns.length > 0
      ? insertShape.targetColumns.length
      : targetSchemaColumns.length;
    if (expectedCount !== projection.length) {
      issues.push({
        start: target.position.startIndex,
        end: target.position.endIndex + 1,
        message: `INSERT writes ${projection.length} value(s) into ${expectedCount} target column(s).`,
        code: 'insert-column-count',
      });
    }
    for (let index = 0; index < Math.min(targetSchemaColumns.length, projection.length); index += 1) {
      const targetColumn = targetSchemaColumns[index]!;
      const sourceColumn = projection[index]!;
      const sourceScope = smallestContainingScope(scopes, sourceColumn.position.startIndex);
      const sourceFamily = inferExpressionType(sourceColumn.text, sourceScope?.relations ?? [], dialect);
      if (!areTypesCompatible(targetColumn.typeFamily, sourceFamily)) {
        issues.push({
          start: sourceColumn.position.startIndex,
          end: sourceColumn.position.endIndex + 1,
          message: `Cannot assign ${sourceFamily} value to ${targetColumn.name} (${targetColumn.type || targetColumn.typeFamily}).`,
          code: 'incompatible-type',
        });
      }
    }
  }
}

function validateUnionShapes(
  text: string,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  placeholders: readonly RegExp[],
  issues: SqlSemanticIssue[],
): void {
  const tokens = lexSql(text, dialect, placeholders).filter((token) => token.channel === 0);
  let depth = 0;
  const branches: Array<{ start: number; end: number }> = [];
  let branchStart = 0;
  for (const token of tokens) {
    if (token.text === '(') depth += 1;
    if (token.text === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && tokenUpper(token) === 'UNION') {
      branches.push({ start: branchStart, end: token.start });
      branchStart = token.end;
    }
  }
  if (branches.length === 0) {
    return;
  }
  branches.push({ start: branchStart, end: text.length });
  const outputs = branches.map((branch, index) => deriveQueryColumns(
    normalizeUnionBranch(text.slice(branch.start, branch.end), index),
    dialect,
    snapshot,
    new Map(),
    placeholders,
  ));
  const counts = outputs.map((columns) => columns.length);
  const expected = counts[0];
  for (let index = 1; index < counts.length; index += 1) {
    if (counts[index] !== expected) {
      const branch = branches[index]!;
      issues.push({
        start: branch.start,
        end: Math.min(branch.start + 6, branch.end),
        message: `UNION branch returns ${counts[index]} column(s); expected ${expected}.`,
        code: 'union-column-count',
      });
      continue;
    }
    for (let columnIndex = 0; columnIndex < (expected ?? 0); columnIndex += 1) {
      const expectedColumn = outputs[0]?.[columnIndex];
      const actualColumn = outputs[index]?.[columnIndex];
      if (expectedColumn && actualColumn && !areTypesCompatible(expectedColumn.typeFamily, actualColumn.typeFamily)) {
        const branch = branches[index]!;
        issues.push({
          start: branch.start,
          end: Math.min(branch.start + 6, branch.end),
          message: `UNION column ${columnIndex + 1} has incompatible ${actualColumn.typeFamily} and ${expectedColumn.typeFamily} types.`,
          code: 'incompatible-type',
        });
      }
    }
  }
}

function validateUpdateAssignments(
  text: string,
  entities: readonly EntityContext[],
  scopes: readonly MutableScope[],
  dialect: SqlDialect,
  issues: SqlSemanticIssue[],
): void {
  const updateTable = flattenEntities(entities).find((entity) => (
    entity.entityContextType === 'table'
      && entity.belongStmt.stmtContextType === 'commonStmt'
      && /^\s*UPDATE\b/iu.test(text.slice(entity.belongStmt.position.startIndex, entity.belongStmt.position.endIndex + 1))
  ));
  if (!updateTable) return;
  const scope = smallestContainingScope(scopes, updateTable.position.startIndex);
  const binding = scope?.relations.find((candidate) => bindingMatchesQualifier(candidate, updateTable.text, dialect));
  if (!binding || binding.unresolved) return;
  const assignmentPattern = /(?:\bSET\b|,)\s*(?<column>(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$]+))\s*=\s*(?<value>'(?:[^']|'')*'|[-+]?\d+(?:\.\d+)?|TRUE|FALSE)/giu;
  for (const match of text.matchAll(assignmentPattern)) {
    const columnName = match.groups?.column;
    const value = match.groups?.value;
    if (!columnName || !value || match.index === undefined) continue;
    const column = findColumn(binding.columns, columnName, dialect);
    if (!column) continue;
    const sourceFamily = inferExpressionType(value, [], dialect);
    if (!areTypesCompatible(column.typeFamily, sourceFamily)) {
      const valueOffset = match.index + match[0].lastIndexOf(value);
      issues.push({
        start: valueOffset,
        end: valueOffset + value.length,
        message: `Cannot assign ${sourceFamily} value to ${column.name} (${column.type || column.typeFamily}).`,
        code: 'incompatible-type',
      });
    }
  }
}

function normalizeUnionBranch(branch: string, index: number): string {
  return index === 0 ? branch : branch.replace(/^\s*(?:ALL|DISTINCT)\b/iu, '');
}

function areTypesCompatible(target: SqlTypeFamily, source: SqlTypeFamily): boolean {
  if (target === 'unknown' || source === 'unknown' || target === source) return true;
  return (target === 'date' && source === 'time') || (target === 'time' && source === 'date');
}

function extractViewDefinition(
  text: string,
  entity: EntityContext,
  dialect: SqlDialect,
  source: string,
): SchemaViewDefinition | undefined {
  const statementStart = entity.belongStmt.position.startIndex;
  const statementEnd = entity.belongStmt.position.endIndex + 1;
  const tokens = lexSql(text, dialect).filter((token) => (
    token.channel === 0 && token.start >= statementStart && token.end <= statementEnd
  ));
  const asIndex = tokens.findIndex((token) => (
    token.start > entity.position.endIndex && tokenUpper(token) === 'AS'
  ));
  const queryStart = tokens[asIndex + 1]?.start;
  const queryEnd = statementEnd;
  if (asIndex < 0 || queryStart === undefined) return undefined;
  if (queryEnd <= queryStart) return undefined;
  const name = entity.text.trim();
  const parts = splitQualifiedName(name);
  let explicitColumns = isCommonEntity(entity)
    ? (entity.columns ?? [])
      .filter((column) => column.entityContextType === 'columnCreate')
      .map((column) => unquoteIdentifier(column.text))
    : [];
  if (explicitColumns.length === 0) {
    const between = tokens.slice(0, asIndex).filter((token) => token.start > entity.position.endIndex);
    const open = between.findIndex((token) => token.text === '(');
    const close = open >= 0 ? findMatchingToken(between, open, '(', ')') : -1;
    if (open >= 0 && close > open) {
      explicitColumns = between.slice(open + 1, close)
        .filter((token) => isIdentifierToken(token, dialect))
        .map((token) => unquoteIdentifier(token.text));
    }
  }
  return {
    name,
    normalizedName: normalizeQualifiedName(name, dialect),
    normalizedLeafName: parts.at(-1)
      ? normalizeIdentifier(parts.at(-1)!.text, parts.at(-1)!.quoted, dialect)
      : '',
    query: text.slice(queryStart, queryEnd),
    explicitColumns,
    dialect,
    source,
    start: entity.position.startIndex,
    end: entity.position.endIndex + 1,
    queryStart,
  };
}

function isSchemaViewDefinition(
  object: SchemaTable | SchemaViewDefinition,
): object is SchemaViewDefinition {
  return 'query' in object;
}

function isUsableOutputColumn(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !/^[-+]?\d/u.test(trimmed) && !/[()+*/%<>=]/u.test(trimmed);
}

function extractDeclaredColumns(entity: EntityContext, dialect: SqlDialect): SchemaColumn[] {
  if (!isCommonEntity(entity)) {
    return [];
  }
  return (entity.columns ?? []).flatMap((column) => {
    let name = column.text.trim();
    let type = column._colType?.text?.trim() ?? '';
    if (!type) {
      const match = /^(?<name>(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[^\s]+))\s+(?<type>.+)$/u.exec(name);
      if (match?.groups) {
        name = match.groups.name ?? name;
        type = match.groups.type ?? '';
      }
    }
    if (!name) {
      return [];
    }
    const quoted = isQuotedIdentifier(name);
    const visibleName = unquoteIdentifier(name);
    const dataType = parseSqlDataType(type, dialect);
    return [{
      name: visibleName,
      normalizedName: normalizeIdentifier(visibleName, quoted, dialect),
      type,
      typeFamily: dataTypeFamily(dataType),
      dataType,
      start: column.position.startIndex,
      end: column.position.endIndex + 1,
    }];
  });
}

function declaredColumn(
  rawName: string,
  type: string,
  start: number,
  end: number,
  dialect: SqlDialect,
): SchemaColumn {
  const quoted = isQuotedIdentifier(rawName);
  const name = unquoteIdentifier(rawName);
  const dataType = parseSqlDataType(type, dialect);
  return {
    name,
    normalizedName: normalizeIdentifier(name, quoted, dialect),
    type,
    typeFamily: dataTypeFamily(dataType),
    dataType,
    start,
    end,
  };
}

function extractInsertShape(
  statement: string,
  dialect: SqlDialect,
): { targetColumns: string[]; staticPartitionColumns: string[] } {
  const tokens = lexSql(statement, dialect).filter((token) => token.channel === 0);
  const into = tokens.findIndex((token) => tokenUpper(token) === 'INTO');
  if (into < 0) return { targetColumns: [], staticPartitionColumns: [] };
  let cursor = into + 1;
  while (cursor < tokens.length && tokens[cursor]?.text !== '('
    && tokenUpper(tokens[cursor]) !== 'PARTITION'
    && tokenUpper(tokens[cursor]) !== 'VALUES'
    && tokenUpper(tokens[cursor]) !== 'SELECT') {
    cursor += 1;
  }
  let targetColumns: string[] = [];
  if (tokens[cursor]?.text === '(') {
    const close = findMatchingToken(tokens, cursor, '(', ')');
    if (close > cursor) {
      targetColumns = tokens.slice(cursor + 1, close)
        .filter((token, index, columns) => isIdentifierToken(token, dialect)
          && (index === 0 || columns[index - 1]?.text === ','))
        .map((token) => normalizeBareIdentifier(token.text, dialect));
      cursor = close + 1;
    }
  }
  const partition = tokens.findIndex((token, index) => index >= cursor && tokenUpper(token) === 'PARTITION');
  const staticPartitionColumns: string[] = [];
  if (partition >= 0 && tokens[partition + 1]?.text === '(') {
    const open = partition + 1;
    const close = findMatchingToken(tokens, open, '(', ')');
    let depth = 0;
    for (let index = open + 1; index < close; index += 1) {
      const token = tokens[index]!;
      if (token.text === '(') depth += 1;
      if (token.text === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && isIdentifierToken(token, dialect) && tokens[index + 1]?.text === '=') {
        staticPartitionColumns.push(normalizeBareIdentifier(token.text, dialect));
      }
    }
  }
  return { targetColumns, staticPartitionColumns };
}

function inferExpressionType(
  expression: string,
  bindings: readonly RelationBinding[],
  dialect: SqlDialect,
): SqlTypeFamily {
  return dataTypeFamily(inferExpressionDataType(expression, bindings, dialect));
}

function inferExpressionDataType(
  expression: string,
  bindings: readonly RelationBinding[],
  dialect: SqlDialect,
): SqlDataType {
  const trimmed = trimOuterParentheses(expression.trim());
  const direct = resolveColumnFromBindings(bindings, trimmed, dialect);
  if (direct) return columnDataType(direct, dialect);
  if (/^[-+]?\d+(?:\.\d+)?$/u.test(trimmed)) return dataTypeFromFamily('number');
  if (/^'(?:[^']|'')*'$/su.test(trimmed)) return dataTypeFromFamily('string');
  if (/^(?:TRUE|FALSE)$/iu.test(trimmed)) return dataTypeFromFamily('boolean');

  const fieldAccess = trailingFieldAccess(trimmed);
  if (fieldAccess) {
    const baseType = inferExpressionDataType(fieldAccess.base, bindings, dialect);
    return fieldDataType(baseType, fieldAccess.field, dialect) ?? UNKNOWN_DATA_TYPE;
  }

  const invocation = parseFunctionInvocation(trimmed);
  if (!invocation) return UNKNOWN_DATA_TYPE;
  const name = normalizeBareIdentifier(invocation.name.split('.').at(-1) ?? invocation.name, dialect)
    .replace(/^!/u, '');
  const arguments_ = splitTopLevel(invocation.arguments, ',');
  if (name === 'from_json' && arguments_[1]) {
    const schema = unquoteSqlString(arguments_[1].trim());
    return schema === undefined ? UNKNOWN_DATA_TYPE : parseSqlDataType(schema, dialect);
  }
  if (name === 'struct') {
    const fields = arguments_.map((argument, index) => {
      const outputName = expressionOutputName(argument, index);
      const dataType = inferExpressionDataType(argument, bindings, dialect);
      return virtualColumn(outputName, dataTypeFamily(dataType), '', dataType);
    });
    return { kind: 'struct', fields };
  }
  if (name === 'named_struct') {
    const fields: SchemaColumn[] = [];
    for (let index = 0; index + 1 < arguments_.length; index += 2) {
      const fieldName = unquoteSqlString(arguments_[index]!.trim());
      if (fieldName === undefined) return UNKNOWN_DATA_TYPE;
      const dataType = inferExpressionDataType(arguments_[index + 1]!, bindings, dialect);
      fields.push(virtualColumn(fieldName, dataTypeFamily(dataType), '', dataType));
    }
    return { kind: 'struct', fields };
  }
  if (name === 'split') {
    return { kind: 'array', elementType: dataTypeFromFamily('string') };
  }
  if (name === 'size' || name === 'cardinality') {
    return dataTypeFromFamily('number');
  }
  if (name === 'array') {
    return {
      kind: 'array',
      elementType: arguments_[0]
        ? inferExpressionDataType(arguments_[0], bindings, dialect)
        : UNKNOWN_DATA_TYPE,
    };
  }
  if (name === 'map') {
    return {
      kind: 'map',
      keyType: arguments_[0]
        ? inferExpressionDataType(arguments_[0], bindings, dialect)
        : UNKNOWN_DATA_TYPE,
      valueType: arguments_[1]
        ? inferExpressionDataType(arguments_[1], bindings, dialect)
        : UNKNOWN_DATA_TYPE,
    };
  }
  return UNKNOWN_DATA_TYPE;
}

function resolveColumnFromBindings(
  bindings: readonly RelationBinding[],
  reference: string,
  dialect: SqlDialect,
): SchemaColumn | undefined {
  const parts = splitQualifiedName(reference);
  const name = parts.at(-1)?.text ?? reference;
  if (parts.length > 1) {
    const qualifier = parts.slice(0, -1).map((part) => part.text).join('.');
    const binding = bindings.find((candidate) => bindingMatchesQualifier(candidate, qualifier, dialect));
    return binding ? findColumn(binding.columns, name, dialect) : undefined;
  }
  const matches = bindings.flatMap((binding) => {
    const column = findColumn(binding.columns, name, dialect);
    return column ? [column] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function typeFamily(type: string): SqlTypeFamily {
  const upper = type.toUpperCase();
  if (/\b(?:TINYINT|SMALLINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|REAL|DOUBLE|NUMBER|MONEY)\b/u.test(upper)) return 'number';
  if (/\b(?:CHAR|VARCHAR|STRING|TEXT|CLOB|JSON|UUID)\b/u.test(upper)) return 'string';
  if (/\b(?:BOOL|BOOLEAN)\b/u.test(upper)) return 'boolean';
  if (/\bDATE\b/u.test(upper)) return 'date';
  if (/\b(?:TIME|TIMESTAMP|DATETIME)\b/u.test(upper)) return 'time';
  if (/\b(?:BINARY|VARBINARY|BLOB|BYTEA)\b/u.test(upper)) return 'binary';
  if (/\b(?:ARRAY|MAP|STRUCT|ROW|MULTISET)\b/u.test(upper)) return 'complex';
  return 'unknown';
}

function parseSqlDataType(type: string, dialect: SqlDialect): SqlDataType {
  const trimmed = type.trim();
  if (!trimmed) return UNKNOWN_DATA_TYPE;
  if (trimmed.endsWith('[]')) {
    return { kind: 'array', elementType: parseSqlDataType(trimmed.slice(0, -2), dialect) };
  }
  const arrayBody = genericTypeBody(trimmed, 'ARRAY');
  if (arrayBody !== undefined) {
    return { kind: 'array', elementType: parseSqlDataType(arrayBody, dialect) };
  }
  const mapBody = genericTypeBody(trimmed, 'MAP');
  if (mapBody !== undefined) {
    const parts = splitTopLevel(mapBody, ',');
    return parts.length === 2
      ? {
          kind: 'map',
          keyType: parseSqlDataType(parts[0]!, dialect),
          valueType: parseSqlDataType(parts[1]!, dialect),
        }
      : UNKNOWN_DATA_TYPE;
  }
  const structBody = genericTypeBody(trimmed, 'STRUCT') ?? parenthesizedTypeBody(trimmed, 'ROW');
  if (structBody !== undefined) {
    const fields = splitTopLevel(structBody, ',').flatMap((definition) => {
      const field = splitTypeField(definition);
      return field
        ? [declaredColumn(field.name, field.type, 0, 0, dialect)]
        : [];
    });
    return fields.length > 0 ? { kind: 'struct', fields } : UNKNOWN_DATA_TYPE;
  }
  const family = typeFamily(trimmed);
  return family === 'complex' || family === 'unknown'
    ? UNKNOWN_DATA_TYPE
    : { kind: 'scalar', family, name: trimmed };
}

function dataTypeFamily(dataType: SqlDataType): SqlTypeFamily {
  if (dataType.kind === 'unknown') return 'unknown';
  if (dataType.kind === 'scalar') return dataType.family;
  return 'complex';
}

function dataTypeFromFamily(family: SqlTypeFamily): SqlDataType {
  if (family === 'unknown' || family === 'complex') return UNKNOWN_DATA_TYPE;
  return { kind: 'scalar', family, name: family };
}

function columnDataType(column: SchemaColumn, dialect: SqlDialect): SqlDataType {
  return column.dataType ?? (column.type ? parseSqlDataType(column.type, dialect) : dataTypeFromFamily(column.typeFamily));
}

function resolveNestedFields(
  dataType: SqlDataType,
  fields: readonly string[],
  dialect: SqlDialect,
): boolean {
  let current = dataType;
  for (const field of fields) {
    if (current.kind === 'unknown') return true;
    const next = fieldDataType(current, field, dialect);
    if (!next) return false;
    current = next;
  }
  return true;
}

function fieldDataType(dataType: SqlDataType, field: string, dialect: SqlDialect): SqlDataType | undefined {
  if (dataType.kind === 'unknown') return UNKNOWN_DATA_TYPE;
  if (dataType.kind === 'array') {
    const elementField = fieldDataType(dataType.elementType, field, dialect);
    return elementField ? { kind: 'array', elementType: elementField } : undefined;
  }
  if (dataType.kind !== 'struct') return undefined;
  const column = findColumn(dataType.fields, field, dialect);
  return column ? columnDataType(column, dialect) : undefined;
}

function genericTypeBody(type: string, keyword: string): string | undefined {
  const match = new RegExp(`^${keyword}\\s*<`, 'iu').exec(type);
  if (!match || !type.endsWith('>')) return undefined;
  return type.slice(match[0].length, -1);
}

function parenthesizedTypeBody(type: string, keyword: string): string | undefined {
  const match = new RegExp(`^${keyword}\\s*\\(`, 'iu').exec(type);
  if (!match || !type.endsWith(')')) return undefined;
  return type.slice(match[0].length, -1);
}

function splitTypeField(definition: string): { name: string; type: string } | undefined {
  const trimmed = definition.trim();
  let quote = '';
  let nested = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (quote) {
      if ((quote === '[' && character === ']') || (quote !== '[' && character === quote)) quote = '';
      continue;
    }
    if (character === '`' || character === '"' || character === '[') {
      quote = character;
    } else if (character === '<' || character === '(') {
      nested += 1;
    } else if (character === '>' || character === ')') {
      nested = Math.max(0, nested - 1);
    } else if (nested === 0 && (character === ':' || /\s/u.test(character))) {
      const name = trimmed.slice(0, index).trim();
      const type = trimmed.slice(index + 1).trim();
      return name && type ? { name, type } : undefined;
    }
  }
  return undefined;
}

function splitTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let start = 0;
  let round = 0;
  let angle = 0;
  let square = 0;
  let quote = '';
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index] ?? separator;
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote && quote !== '`') index += 1;
        else quote = '';
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') round += 1;
    else if (character === ')') round = Math.max(0, round - 1);
    else if (character === '<') angle += 1;
    else if (character === '>') angle = Math.max(0, angle - 1);
    else if (character === '[') square += 1;
    else if (character === ']') square = Math.max(0, square - 1);
    else if (character === separator && round === 0 && angle === 0 && square === 0) {
      const part = value.slice(start, index).trim();
      if (part) result.push(part);
      start = index + 1;
    }
  }
  return result;
}

function trimOuterParentheses(value: string): string {
  let current = value;
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = false;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === '(') depth += 1;
      if (current[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = index === current.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

function trailingFieldAccess(value: string): { base: string; field: string } | undefined {
  let round = 0;
  let angle = 0;
  let quote = '';
  let lastDot = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') round += 1;
    else if (character === ')') round = Math.max(0, round - 1);
    else if (character === '<') angle += 1;
    else if (character === '>') angle = Math.max(0, angle - 1);
    else if (character === '.' && round === 0 && angle === 0) lastDot = index;
  }
  if (lastDot <= 0) return undefined;
  const field = value.slice(lastDot + 1).trim();
  return field && /^(?:`[^`]+`|"[^"]+"|[\p{L}_$][\p{L}\p{N}_$]*)$/u.test(field)
    ? { base: value.slice(0, lastDot).trim(), field }
    : undefined;
}

function parseFunctionInvocation(value: string): { name: string; arguments: string } | undefined {
  const open = value.indexOf('(');
  if (open <= 0 || !value.endsWith(')')) return undefined;
  const name = value.slice(0, open).trim();
  if (!/^(?:`[^`]+`|"[^"]+"|[\p{L}_$][\p{L}\p{N}_$]*)(?:\.(?:`[^`]+`|"[^"]+"|[\p{L}_$][\p{L}\p{N}_$]*))*$/u.test(name)) {
    return undefined;
  }
  return { name, arguments: value.slice(open + 1, -1) };
}

function unquoteSqlString(value: string): string | undefined {
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replace(/''/gu, "'")
    : undefined;
}

function expressionOutputName(expression: string, index: number): string {
  const trimmed = expression.trim();
  const parts = splitQualifiedName(trimmed);
  if (parts.length > 0 && !/[()+*/%<>=]/u.test(trimmed)) {
    return parts.at(-1)!.text;
  }
  return `col${index + 1}`;
}

function virtualColumn(
  name: string,
  family: SqlTypeFamily = 'unknown',
  type = '',
  dataType: SqlDataType = type ? parseSqlDataType(type, 'generic') : dataTypeFromFamily(family),
): SchemaColumn {
  return {
    name,
    normalizedName: name.toLocaleLowerCase(),
    type,
    typeFamily: family,
    dataType,
    start: 0,
    end: 0,
  };
}

function findColumn(columns: readonly SchemaColumn[], name: string, dialect: SqlDialect): SchemaColumn | undefined {
  const normalized = normalizeBareIdentifier(name, dialect);
  return columns.find((column) => column.normalizedName === normalized);
}

function bindingMatchesQualifier(binding: RelationBinding, qualifier: string, dialect: SqlDialect): boolean {
  const normalized = normalizeQualifiedName(qualifier, dialect);
  const leaf = normalized.split('.').at(-1);
  return binding.aliases.some((alias) => alias === normalized || alias.split('.').at(-1) === leaf);
}

function normalizeQualifiedName(name: string, dialect: SqlDialect): string {
  return splitQualifiedName(name)
    .map((part) => normalizeIdentifier(part.text, part.quoted, dialect))
    .join('.');
}

function normalizeBareIdentifier(name: string, dialect: SqlDialect): string {
  const trimmed = name.trim();
  return normalizeIdentifier(unquoteIdentifier(trimmed), isQuotedIdentifier(trimmed), dialect);
}

function normalizeIdentifier(name: string, quoted: boolean, dialect: SqlDialect): string {
  const folded = name.toLocaleLowerCase();
  if (dialect === 'postgresql' && quoted && name !== folded) {
    return `!${name}`;
  }
  return folded;
}

function splitQualifiedName(value: string): Array<{ text: string; quoted: boolean }> {
  const result: Array<{ text: string; quoted: boolean }> = [];
  let start = 0;
  let quote = '';
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index] ?? '.';
    if (quote) {
      if ((quote === '[' && character === ']') || (quote !== '[' && character === quote)) {
        quote = '';
      }
      continue;
    }
    if (character === '`' || character === '"' || character === '[') {
      quote = character;
    } else if (character === '.') {
      const raw = value.slice(start, index).trim();
      if (raw) result.push({ text: unquoteIdentifier(raw), quoted: isQuotedIdentifier(raw) });
      start = index + 1;
    }
  }
  return result;
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('`') && trimmed.endsWith('`'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isQuotedIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith('`') && trimmed.endsWith('`'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function isIdentifierToken(token: SqlLexToken, dialect: SqlDialect): boolean {
  const symbolic = token.symbolicName.toUpperCase();
  if (symbolic.startsWith('KW_') || symbolic.includes('STRING') || symbolic.includes('NUMBER')
    || symbolic.includes('COMMENT')) {
    return false;
  }
  if (symbolic.includes('IDENTIFIER') || symbolic === 'ID') {
    return true;
  }
  if (isQuotedIdentifier(token.text)) {
    return true;
  }
  if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(token.text)) {
    return false;
  }
  return !getSqlCatalog(dialect).keywords.includes(token.text.toUpperCase());
}

function flattenEntities(entities: readonly EntityContext[]): EntityContext[] {
  const result: EntityContext[] = [];
  const seen = new Set<EntityContext>();
  const visit = (entity: EntityContext): void => {
    if (seen.has(entity)) return;
    seen.add(entity);
    result.push(entity);
    for (const related of entity.relatedEntities ?? []) visit(related);
    if (isCommonEntity(entity)) {
      for (const column of entity.columns ?? []) visit(column);
    }
  };
  entities.forEach(visit);
  return result;
}

function isCommonEntity(entity: EntityContext): entity is CommonEntityContext {
  return 'columns' in entity || entity.entityContextType === 'table' || entity.entityContextType === 'tableCreate'
    || entity.entityContextType === 'view' || entity.entityContextType === 'viewCreate'
    || entity.entityContextType === 'queryResult';
}

function isExpressionTable(entity: EntityContext): boolean {
  return ('declareType' in entity && entity.declareType === 1) || entity.text.trimStart().startsWith('(');
}

function scopeForStatement(
  scopes: readonly MutableScope[],
  start: number,
  end: number,
  depth: number,
): MutableScope | undefined {
  return scopes.find((scope) => scope.start === start && scope.end === end && scope.depth === depth)
    ?? scopes.find((scope) => scope.start <= start && scope.end >= end && scope.depth === depth);
}

function smallestContainingScope(scopes: readonly MutableScope[], offset: number): MutableScope | undefined {
  return containingScopes(scopes, offset)[0];
}

function containingScopes(scopes: readonly MutableScope[], offset: number): MutableScope[] {
  return scopes.filter((scope) => offset >= scope.start && offset <= scope.end)
    .sort((left, right) => right.depth - left.depth || (left.end - left.start) - (right.end - right.start));
}

function findMatchingToken(
  tokens: readonly SqlLexToken[],
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.text === open) depth += 1;
    if (tokens[index]?.text === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function tokenUpper(token: SqlLexToken | undefined): string {
  return token?.text.toUpperCase() ?? '';
}

function overlapsAny(
  span: { start: number; end: number },
  ranges: readonly { start: number; end: number }[],
): boolean {
  return ranges.some((range) => span.start < range.end && range.start < span.end);
}

function entityRange(entity: EntityContext): { start: number; end: number } {
  return { start: entity.position.startIndex, end: entity.position.endIndex + 1 };
}

function deduplicateColumns(columns: readonly SchemaColumn[]): SchemaColumn[] {
  const seen = new Set<string>();
  return columns.filter((column) => {
    if (seen.has(column.normalizedName)) return false;
    seen.add(column.normalizedName);
    return true;
  });
}

function deduplicateSemanticIssues(issues: readonly SqlSemanticIssue[]): SqlSemanticIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.start}:${issue.end}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
