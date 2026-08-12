import type { CommonEntityContext, EntityContext } from 'dt-sql-parser';

import { findPlaceholderRanges } from './patterns';
import { analyzeSql, getSqlEntities, lexSql, type SqlDialect, type SqlLexToken } from './sql';
import { getSqlCatalog } from './sqlCatalog';

export type SqlTypeFamily = 'number' | 'string' | 'boolean' | 'date' | 'time' | 'binary' | 'complex' | 'unknown';

export interface SchemaColumn {
  name: string;
  normalizedName: string;
  type: string;
  typeFamily: SqlTypeFamily;
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
}

export interface RelationBinding {
  name: string;
  aliases: readonly string[];
  columns: readonly SchemaColumn[];
  unresolved: boolean;
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

  const entities = getSqlEntities(text, dialect);
  const createTables = entities.filter((entity) => entity.entityContextType === 'tableCreate');
  const createViews = entities.filter((entity) => entity.entityContextType === 'viewCreate');
  const tables: SchemaTable[] = [];
  const views: SchemaViewDefinition[] = [];
  const issues: SchemaIssue[] = [];
  for (const entity of createTables) {
    const columns = extractDeclaredColumns(entity, dialect);
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
      const columns = extractDeclaredColumns(entity, dialect);
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
  const entities = getSqlEntities(text, dialect, placeholders);
  const tokens = lexSql(text, dialect, placeholders).filter((token) => token.channel === 0);
  const ctes = extractCtes(text, tokens, dialect, snapshot, placeholders);
  const scopes = createScopes(entities, text.length);
  const issues: SqlSemanticIssue[] = [];
  const skipRanges: Array<{ start: number; end: number }> = [];

  for (const cte of ctes.values()) {
    skipRanges.push({ start: cte.declarationStart, end: cte.declarationEnd });
  }

  const tableEntities = flattenEntities(entities).filter((entity) => (
    entity.entityContextType === 'table' || entity.entityContextType === 'view'
  ));
  for (const entity of tableEntities) {
    skipRanges.push(entityRange(entity));
    if (entity._alias) {
      skipRanges.push(wordRange(entity._alias));
    }
    const scope = scopeForStatement(scopes, entity.belongStmt.position.startIndex, entity.belongStmt.position.endIndex + 1, entity.belongStmt.scopeDepth);
    if (!scope) {
      continue;
    }
    const binding = bindingForEntity(entity, dialect, snapshot, ctes, placeholders);
    scope.relations.push(binding);
    if (validate && binding.unresolved && !isExpressionTable(entity)) {
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
    if (entity._alias && entity.entityContextType === 'column') {
      skipRanges.push(wordRange(entity._alias));
      const scope = smallestContainingScope(scopes, entity.position.startIndex);
      scope?.projectionAliases.add(normalizeBareIdentifier(entity._alias.text, dialect));
    }
  }

  const references = scanIdentifierReferences(tokens, dialect, skipRanges, placeholders, text);
  if (validate) {
    validateReferences(references, scopes, dialect, snapshot, udfs, issues);
    validateInsertShapes(text, entities, scopes, dialect, issues);
    validateUnionShapes(text, dialect, snapshot, placeholders, issues);
    validateUpdateAssignments(text, entities, scopes, dialect, issues);
  }
  return { scopes, references, issues: deduplicateSemanticIssues(issues) };
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
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  ctes: ReadonlyMap<string, CteDefinition>,
  placeholders: readonly RegExp[],
): RelationBinding {
  const alias = entity._alias?.text;
  const aliases = [alias, entity.text, splitQualifiedName(entity.text).at(-1)?.text]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeQualifiedName(value, dialect));
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
    .map((entity) => bindingForEntity(entity, dialect, snapshot, ctes, placeholders));
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
      result.push(virtualColumn(alias, inferExpressionType(raw, sourceBindings, dialect)));
      continue;
    }
    if (!/[()+*/%<>=]/u.test(raw)) {
      const name = splitQualifiedName(raw).at(-1)?.text ?? raw;
      const sourceColumn = resolveColumnFromBindings(sourceBindings, raw, dialect);
      result.push(sourceColumn ?? virtualColumn(unquoteIdentifier(name)));
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
  const entities = getSqlEntities(text, dialect, placeholders);
  const results = flattenEntities(entities)
    .filter((entity): entity is CommonEntityContext => entity.entityContextType === 'queryResult' && isCommonEntity(entity))
    .sort((left, right) => left.belongStmt.scopeDepth - right.belongStmt.scopeDepth);
  const result = results[0];
  return result ? columnsFromQueryResult(result, dialect, snapshot, ctes, placeholders) : [];
}

function scanIdentifierReferences(
  tokens: readonly SqlLexToken[],
  dialect: SqlDialect,
  skipRanges: readonly { start: number; end: number }[],
  placeholders: readonly RegExp[],
  text: string,
): IdentifierReference[] {
  const references: IdentifierReference[] = [];
  const placeholderRanges = findPlaceholderRanges(text, placeholders);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || (!isIdentifierToken(token, dialect) && tokens[index + 1]?.text !== '.')
      || tokens[index - 1]?.text === '.') {
      continue;
    }
    const parts = [token.text];
    let endIndex = index;
    while (tokens[endIndex + 1]?.text === '.' && tokens[endIndex + 2]
      && isIdentifierPartToken(tokens[endIndex + 2]!)) {
      parts.push(tokens[endIndex + 2]!.text);
      endIndex += 2;
    }
    const endToken = tokens[endIndex]!;
    const span = { start: token.start, end: endToken.end };
    index = endIndex;
    if (overlapsAny(span, skipRanges) || overlapsAny(span, placeholderRanges)) {
      continue;
    }
    const previous = tokens[index - (parts.length * 2 - 2) - 1];
    if (tokenUpper(previous) === 'AS') {
      continue;
    }
    references.push({
      text: text.slice(span.start, span.end),
      parts,
      start: span.start,
      end: span.end,
      isFunction: tokens[endIndex + 1]?.text === '(',
    });
  }
  return references;
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
        });
      }
      continue;
    }

    const availableScopes = containingScopes(scopes, reference.start);
    if (availableScopes.length === 0) {
      continue;
    }
    if (reference.parts.length > 1) {
      const qualifier = reference.parts.slice(0, -1).join('.');
      const columnName = reference.parts.at(-1)!;
      const binding = availableScopes
        .map((scope) => scope.relations.find((candidate) => bindingMatchesQualifier(candidate, qualifier, dialect)))
        .find((candidate) => candidate !== undefined);
      if (!binding) {
        issues.push({
          start: reference.start,
          end: reference.end - columnName.length - 1,
          message: `Unknown table or alias ${qualifier}.`,
          code: 'unknown-qualifier',
        });
      } else if (!binding.unresolved && !findColumn(binding.columns, columnName, dialect)) {
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
    const targetColumns = extractInsertTargetColumns(statementText, target.text, dialect);
    const targetSchemaColumns = targetColumns.length > 0
      ? targetColumns.flatMap((name) => {
          const column = targetBinding.columns.find((candidate) => candidate.normalizedName === name);
          return column ? [column] : [];
        })
      : [...targetBinding.columns];
    const expectedCount = targetColumns.length > 0 ? targetColumns.length : targetSchemaColumns.length;
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
    return [{
      name: visibleName,
      normalizedName: normalizeIdentifier(visibleName, quoted, dialect),
      type,
      typeFamily: typeFamily(type),
      start: column.position.startIndex,
      end: column.position.endIndex + 1,
    }];
  });
}

function extractInsertTargetColumns(statement: string, tableName: string, dialect: SqlDialect): string[] {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`\\bINTO\\s+${escaped}\\s*\\(([^)]*)\\)`, 'iu').exec(statement);
  return match?.[1]?.split(',').map((name) => normalizeBareIdentifier(name.trim(), dialect)).filter(Boolean) ?? [];
}

function inferExpressionType(
  expression: string,
  bindings: readonly RelationBinding[],
  dialect: SqlDialect,
): SqlTypeFamily {
  const direct = resolveColumnFromBindings(bindings, expression, dialect);
  if (direct) return direct.typeFamily;
  if (/^[-+]?\d+(?:\.\d+)?$/u.test(expression.trim())) return 'number';
  if (/^'(?:[^']|'')*'$/su.test(expression.trim())) return 'string';
  if (/^(?:TRUE|FALSE)$/iu.test(expression.trim())) return 'boolean';
  return 'unknown';
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

function virtualColumn(name: string, family: SqlTypeFamily = 'unknown', type = ''): SchemaColumn {
  return {
    name,
    normalizedName: name.toLocaleLowerCase(),
    type,
    typeFamily: family,
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
  if (!quoted || (dialect === 'postgresql' && name === folded)) {
    return folded;
  }
  return `!${name}`;
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

function isIdentifierPartToken(token: SqlLexToken): boolean {
  return isQuotedIdentifier(token.text) || /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(token.text);
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

function wordRange(value: { startIndex: number; endIndex: number }): { start: number; end: number } {
  return { start: value.startIndex, end: value.endIndex + 1 };
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
