import { findPlaceholderRanges } from './patterns';
import { analyzeSql, lexSql, type SqlDialect, type SqlLexToken } from './sql';
import {
  astChild,
  astChildren,
  isSqlAstNode,
  parseSqlAst,
  type SqlAstNode,
  type SqlAstValue,
} from './sqlAst';
import { getSqlCatalog } from './sqlCatalog';

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
  const ast = parseSqlAst(text, dialect);
  if (ast) {
    const creates = ast.statements.filter((statement) => statement.role === 'create');
    if (creates.length > 0) return parseAstDdlSchema(text, dialect, source, creates);
  }

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

  // DT is the final syntax gate only. A syntactically valid statement that the
  // normalized AST cannot represent is intentionally skipped conservatively.
  return { tables: [], views: [], issues: [] };
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
      let columns = deriveQueryColumns(view.query, view.dialect, snapshot, []);
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
  const astStatement = parseSqlAst(text, dialect, placeholders)?.statements[0];
  const createMatch = /^CREATE\s+(?<replace>OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?<temporary>TEMP(?:ORARY)?\s+)?(?<kind>TABLE|VIEW)\b/iu.exec(body);
  if (createMatch?.groups && astStatement?.role === 'create') {
    const kind = astPrimitiveString(astStatement.args.kind).toLocaleLowerCase() as 'table' | 'view';
    if (kind !== 'table' && kind !== 'view') return [];
    const target = astChild(astStatement, 'this');
    const schema = target?.role === 'schema' ? target : undefined;
    const objectNode = schema ? astChild(schema, 'this') : target;
    if (!objectNode) return [];
    const name = astTableName(objectNode);
    const temporary = Boolean(createMatch.groups.temporary);
    const ifNotExists = /\bIF\s+NOT\s+EXISTS\b/iu.test(text.slice(0, objectNode.start));
    const orReplace = Boolean(createMatch.groups.replace);
    const effective = effectiveSchemaSnapshot(base, state);
    const existing = resolveSchemaTable(effective, name, dialect);
    const normalizedName = normalizeQualifiedName(name, dialect);
    const localMatch = findLocalObject(state, name, dialect);
    if (existing.status !== 'missing' && !temporary && !orReplace) {
      if (ifNotExists) return [];
      return reportIssues ? [ddlIssue(
        statement,
        objectNode.start,
        objectNode.end,
        `Cannot create ${kind} ${name}; an object with that name already exists.`,
        'duplicate-local-object',
      )] : [];
    }
    if (localMatch && !orReplace) {
      if (ifNotExists) return [];
      return reportIssues ? [ddlIssue(
        statement,
        objectNode.start,
        objectNode.end,
        `Cannot create ${kind} ${name}; a local object with that name already exists.`,
        'duplicate-local-object',
      )] : [];
    }
    const parsed = parseAstDdlSchema(text, dialect, 'local', [astStatement]);
    if (kind === 'table') {
      const parsedTable = parsed.tables[0];
      if (!parsedTable) {
        const issue = parsed.issues[0];
        return reportIssues ? [ddlIssue(
          statement,
          issue?.start ?? objectNode.start,
          issue?.end ?? objectNode.end,
          issue?.message ?? `Table ${name} has no explicit column definitions; CTAS does not create a local schema object.`,
          issue?.code === 'duplicate-schema-column' ? issue.code : 'local-table-without-columns',
        )] : [];
      }
      prepareReplacement(state, existing.table, localMatch, orReplace, temporary);
      state.local.set(normalizedName, {
        ...parsedTable,
        temporary,
        source: 'local',
        start: statement.start + parsedTable.start,
        end: statement.start + parsedTable.end,
      });
      return [];
    }

    const view = parsed.views[0];
    if (!view) {
      return reportIssues ? [ddlIssue(
        statement,
        objectNode.start,
        objectNode.end,
        `View ${name} has no query whose output columns can be inferred.`,
        'local-view-without-query',
      )] : [];
    }
    const queryModel = buildSqlModel(view.query, dialect, effective, placeholders, udfs, true);
    const queryIssues = queryModel.issues.map((issue) => offsetSemanticIssue(
      issue,
      statement.start + view.queryStart,
    ));
    let columns = deriveQueryColumns(view.query, dialect, effective, placeholders);
    if (view.explicitColumns.length > 0) {
      if (view.explicitColumns.length !== columns.length) {
        return reportIssues ? [...queryIssues, ddlIssue(
          statement,
          objectNode.start,
          objectNode.end,
          `View ${name} declares ${view.explicitColumns.length} column(s), but its query returns ${columns.length}.`,
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
          objectNode.start,
          objectNode.end,
          `View ${name} has output columns that cannot be inferred.`,
          'local-view-unresolved',
        )] : []),
      ] : [];
    }
    const parts = splitQualifiedName(name);
    prepareReplacement(state, existing.table, localMatch, orReplace, temporary);
    state.local.set(normalizedName, {
      name,
      normalizedName,
      normalizedLeafName: parts.at(-1) ? normalizeIdentifier(parts.at(-1)!.text, parts.at(-1)!.quoted, dialect) : '',
      kind: 'view',
      temporary,
      columns,
      source: 'local',
      start: statement.start + objectNode.start,
      end: statement.start + objectNode.end,
    });
    return [];
  }

  const dropMatch = /^DROP\s+(?<kind>TABLE|VIEW)\s+(?<ifExists>IF\s+EXISTS\s+)?/iu.exec(body);
  if (!dropMatch?.groups || astStatement?.role !== 'drop') return [];
  const kind = dropMatch.groups.kind?.toLocaleLowerCase() as 'table' | 'view';
  const objectNode = astChild(astStatement, 'this');
  if (!objectNode) return [];
  const name = astTableName(objectNode);
  const effective = effectiveSchemaSnapshot(base, state);
  const resolution = resolveSchemaTable(effective, name, dialect);
  const object = resolution.table;
  if (resolution.status !== 'found' || !object || object.kind !== kind) {
    if (dropMatch.groups.ifExists && resolution.status !== 'ambiguous') return [];
    return reportIssues ? [ddlIssue(
      statement,
      objectNode.start,
      objectNode.end,
      resolution.status === 'ambiguous'
        ? `Cannot drop ${name}; the object reference is ambiguous.`
        : `Cannot drop ${kind} ${name}; no matching object exists.`,
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
  // Syntax has already been checked by the caller. If normalization is not
  // possible, skip claims that cannot be proven instead of guessing from DT
  // entity contexts or source-text fragments.
  return {
    scopes: [{ start: 0, end: text.length, depth: 0, relations: [], projectionAliases: new Set() }],
    references: [],
    issues: [],
  };
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
  readonly qualifier?: string;
  readonly missingName?: string;
}

type AstTypeEnvironment = ReadonlyMap<string, SqlDataType>;
const EMPTY_AST_TYPE_ENVIRONMENT: AstTypeEnvironment = new Map();

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
      'transform', 'filter', 'exists', 'forall', 'aggregate', 'reduce', 'zip_with',
      'map_filter', 'map_zip_with', 'transform_keys', 'transform_values', 'array_sort',
      'named_struct', 'struct', 'array', 'map', 'element_at', 'try_element_at',
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
          if (!areDataTypesCompatible(columnDataType(expected, context.dialect), columnDataType(actual, context.dialect))) {
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
  const localCteNames = new Set<string>();
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
      const normalizedName = normalizeQualifiedName(name, context.dialect);
      if (localCteNames.has(normalizedName)) {
        if (context.validate) appendAstIssue(context, cte, 'duplicate-cte', `Duplicate CTE name ${name}.`);
        continue;
      }
      localCteNames.add(normalizedName);
      ctes.set(normalizedName, {
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
    const columns = query ? analyzeAstQuery(query, context, undefined, ctes) : [];
    return astDerivedBinding(relation, columns, context.dialect);
  }
  if (relation.role === 'lateral') {
    const source = astChild(relation, 'this');
    if (source?.role === 'subquery') {
      const query = astChild(source, 'this');
      const columns = query ? analyzeAstQuery(query, context, scope, ctes) : [];
      return astDerivedBinding(relation.alias ? relation : source, columns, context.dialect);
    }
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
  const path = splitQualifiedName(astTableName(relation)).map((part) => part.text);
  if (path.length < 2) return undefined;
  const resolution = resolveAstColumnPath(scope, path, context.dialect);
  if (resolution.status !== 'found' || !resolution.column) return undefined;
  const dataType = columnDataType(resolution.column, context.dialect);
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
  const alias = relation.alias || path.at(-1) || relation.name;
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
  const inputTypes = inputs.map((input) => inferAstExpressionType(input, scope, context));
  const inputType = inputTypes[0] ?? UNKNOWN_DATA_TYPE;
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
  } else if (functionName === 'explode' || functionName === 'explode_outer') {
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
  } else if (functionName === 'unnest') {
    columns = inputTypes.flatMap((dataType) => {
      if (dataType.kind === 'array') {
        return [virtualColumn('col', dataTypeFamily(dataType.elementType), '', dataType.elementType)];
      }
      if (dataType.kind === 'map') {
        return [
          virtualColumn('key', dataTypeFamily(dataType.keyType), '', dataType.keyType),
          virtualColumn('value', dataTypeFamily(dataType.valueType), '', dataType.valueType),
        ];
      }
      return [virtualColumn('col')];
    });
  } else if (source.kind === 'jsonTable') {
    const schema = astChild(source, 'schema');
    columns = schema ? astJsonTableColumns(schema, context.dialect) : [];
  }

  const typedAliasColumns = astTypedAliasColumns(relation, source, context.dialect);
  if (typedAliasColumns.length > 0) columns = typedAliasColumns;
  const explicit = relation.aliasColumns.length > 0 ? relation.aliasColumns : source.aliasColumns;
  if (explicit.length > 0) {
    columns = columns.map((column, index) => (
      explicit[index] ? renameVirtualColumn(explicit[index]!, column, context.dialect) : column
    ));
    if (columns.length === 0) {
      columns = explicit.map((name) => renameVirtualColumn(name, undefined, context.dialect));
    }
  } else if (columns.length === 0) {
    columns = [virtualColumn(source.outputName || source.name || 'col')];
  }
  const offset = astChild(source, 'offset') ?? astChild(relation, 'offset');
  if (offset && !findColumn(columns, offset.name || 'ordinality', context.dialect)) {
    columns.push(virtualColumn(offset.name || 'ordinality', 'number'));
  }
  const alias = relation.alias || source.alias || source.name || source.kind;
  return {
    name: alias,
    aliases: alias ? [normalizeQualifiedName(alias, context.dialect)] : [],
    columns,
    unresolved: false,
  };
}

function astJsonTableColumns(schema: SqlAstNode, dialect: SqlDialect): SchemaColumn[] {
  return astChildren(schema, 'expressions').flatMap((definition) => {
    const nested = astChild(definition, 'nestedSchema');
    if (nested) return astJsonTableColumns(nested, dialect);
    if (!definition.name) return [];
    if (definition.args.ordinality === true) return [virtualColumn(definition.name, 'number')];
    const dataTypeNode = astChild(definition, 'kind');
    const type = dataTypeNode ? astDataTypeText(dataTypeNode) : '';
    const dataType = parseSqlDataType(type, dialect);
    return [virtualColumn(definition.name, dataTypeFamily(dataType), type, dataType)];
  });
}

function astTypedAliasColumns(
  relation: SqlAstNode,
  source: SqlAstNode,
  dialect: SqlDialect,
): SchemaColumn[] {
  const alias = astChild(relation, 'alias') ?? astChild(source, 'alias');
  if (!alias) return [];
  return astChildren(alias, 'columns').flatMap((definition) => {
    if (definition.kind !== 'columnDef') return [];
    const identifier = astChild(definition, 'this');
    const dataTypeNode = astChild(definition, 'kind');
    if (!identifier?.name || !dataTypeNode) return [];
    const type = astDataTypeText(dataTypeNode);
    const dataType = parseSqlDataType(type, dialect);
    return [virtualColumn(identifier.name, dataTypeFamily(dataType), type, dataType)];
  });
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
  environment: AstTypeEnvironment = EMPTY_AST_TYPE_ENVIRONMENT,
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
  if (node.role === 'identifier' && environment.has(normalizeBareIdentifier(node.name, context.dialect))) return;
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
  if (validateAstHigherOrderExpression(node, scope, ctes, context, environment)) return;
  if (node.kind === 'dot') validateAstNestedField(node, scope, context, environment);
  forEachAstChild(node, (child) => validateAstExpression(child, scope, ctes, context, environment));
}

function validateAstColumn(node: SqlAstNode, scope: AstScope, context: AstModelContext): void {
  const parts = astColumnPath(node);
  const name = parts.at(-1) ?? node.name;
  const qualifier = parts.length > 1 ? parts.slice(0, -1).join('.') : '';
  if (name === '*' && !qualifier) return;
  const resolution = resolveAstColumnPath(scope, parts, context.dialect);
  if (resolution.status === 'found' || resolution.status === 'unresolved') return;
  if (resolution.status === 'ambiguous') {
    appendAstIssue(context, node, 'ambiguous-column',
      `Column ${parts.join('.')} is ambiguous; qualify it with a table alias.`);
  } else if (resolution.status === 'missing-qualifier') {
    const qualifierNode = astChild(node, 'table') ?? astChild(node, 'db') ?? node;
    appendAstIssue(context, qualifierNode, 'unknown-qualifier',
      `Unknown table or alias ${resolution.qualifier || qualifier}.`);
  } else if (name !== '*') {
    appendAstIssue(context, node, 'unknown-column',
      `Unknown column ${resolution.missingName || parts.join('.')}.`);
  }
}

function resolveAstColumn(
  scope: AstScope | undefined,
  qualifier: string,
  name: string,
  dialect: SqlDialect,
): AstColumnResolution {
  const qualifierParts = qualifier ? splitQualifiedName(qualifier).map((part) => part.text) : [];
  return resolveAstColumnPath(scope, [...qualifierParts, name], dialect);
}

function resolveAstColumnPath(
  scope: AstScope | undefined,
  parts: readonly string[],
  dialect: SqlDialect,
): AstColumnResolution {
  if (parts.length === 0) return { status: 'missing-column' };
  for (let current = scope; current; current = current.parent) {
    for (let prefixLength = parts.length - 1; prefixLength >= 1; prefixLength -= 1) {
      const qualifier = parts.slice(0, prefixLength).join('.');
      const binding = current.relations.find((candidate) => bindingMatchesExactQualifier(candidate, qualifier, dialect));
      if (binding) {
        if (binding.unresolved) return { status: 'unresolved' };
        const columnName = parts[prefixLength]!;
        if (columnName === '*') return { status: 'found', qualifier };
        const column = findColumn(binding.columns, columnName, dialect);
        if (!column) return { status: 'missing-column', qualifier, missingName: columnName };
        let dataType = columnDataType(column, dialect);
        for (const field of parts.slice(prefixLength + 1)) {
          const nested = fieldDataType(dataType, field, dialect);
          if (!nested) return { status: 'missing-column', qualifier, missingName: field };
          dataType = nested;
        }
        const outputName = parts.at(-1) ?? column.name;
        return parts.length === prefixLength + 1
          ? { status: 'found', column, qualifier }
          : { status: 'found', column: virtualColumn(outputName, dataTypeFamily(dataType), '', dataType), qualifier };
      }
    }

    const name = parts[0]!;
    if (parts.length === 1 && current.projectionAliases.has(normalizeBareIdentifier(name, dialect))) {
      return { status: 'found' };
    }
    const matches = current.relations.flatMap((binding) => {
      const column = binding.unresolved ? undefined : findColumn(binding.columns, name, dialect);
      return column ? [column] : [];
    });
    if (matches.length === 1) {
      const column = matches[0]!;
      let dataType = columnDataType(column, dialect);
      for (const field of parts.slice(1)) {
        const nested = fieldDataType(dataType, field, dialect);
        if (!nested) return { status: 'missing-column', missingName: field };
        dataType = nested;
      }
      const outputName = parts.at(-1) ?? column.name;
      return parts.length === 1
        ? { status: 'found', column }
        : { status: 'found', column: virtualColumn(outputName, dataTypeFamily(dataType), '', dataType) };
    }
    if (matches.length > 1) return { status: 'ambiguous' };
    if (current.relations.some((binding) => binding.unresolved)) return { status: 'unresolved' };
  }
  return parts.length > 1
    ? { status: 'missing-qualifier', qualifier: parts.slice(0, -1).join('.') }
    : { status: 'missing-column', missingName: parts[0] };
}

function validateAstNestedField(
  node: SqlAstNode,
  scope: AstScope,
  context: AstModelContext,
  environment: AstTypeEnvironment,
): void {
  const base = astChild(node, 'this');
  const field = astChild(node, 'expression');
  if (!base || !field?.name) return;
  const dataType = inferAstExpressionType(base, scope, context, environment);
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
    const name = projection.alias || projection.outputName || expression.outputName || expression.name
      || `_col${columns.length + 1}`;
    const dataType = inferAstExpressionType(expression, scope, context);
    columns.push(renameVirtualColumn(name, virtualColumn(name, dataTypeFamily(dataType), '', dataType), context.dialect));
  }
  return columns;
}

function inferAstExpressionType(
  node: SqlAstNode,
  scope: AstScope | undefined,
  context: AstModelContext,
  environment: AstTypeEnvironment = EMPTY_AST_TYPE_ENVIRONMENT,
): SqlDataType {
  if (node.role === 'alias') {
    const inner = astChild(node, 'this');
    return inner ? inferAstExpressionType(inner, scope, context, environment) : UNKNOWN_DATA_TYPE;
  }
  if (node.role === 'identifier') {
    return environment.get(normalizeBareIdentifier(node.name, context.dialect)) ?? UNKNOWN_DATA_TYPE;
  }
  if (node.role === 'column') {
    const resolution = resolveAstColumnPath(scope, astColumnPath(node), context.dialect);
    return resolution.column ? columnDataType(resolution.column, context.dialect) : UNKNOWN_DATA_TYPE;
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
    const baseType = base ? inferAstExpressionType(base, scope, context, environment) : UNKNOWN_DATA_TYPE;
    return field?.name ? fieldDataType(baseType, field.name, context.dialect) ?? UNKNOWN_DATA_TYPE : UNKNOWN_DATA_TYPE;
  }
  if (node.kind === 'bracket') {
    const base = astChild(node, 'this');
    const baseType = base ? inferAstExpressionType(base, scope, context, environment) : UNKNOWN_DATA_TYPE;
    if (baseType.kind === 'array') return baseType.elementType;
    if (baseType.kind === 'map') return baseType.valueType;
    return UNKNOWN_DATA_TYPE;
  }
  const normalizedFunction = normalizeBareIdentifier(node.name || node.kind, context.dialect).replace(/^!/u, '');
  const args = astExpressionArguments(node);
  const higherOrderType = inferAstHigherOrderType(node, normalizedFunction, scope, context, environment);
  if (higherOrderType) return higherOrderType;
  if (['count', 'row_number', 'rank', 'dense_rank', 'size', 'cardinality'].includes(normalizedFunction)) {
    return dataTypeFromFamily('number');
  }
  if (['sum', 'avg', 'max', 'min'].includes(normalizedFunction) && args[0]) {
    return inferAstExpressionType(args[0], scope, context, environment);
  }
  if (normalizedFunction === 'from_json' && args[1]?.role === 'literal') {
    return parseSqlDataType(args[1].name, context.dialect);
  }
  if (normalizedFunction === 'struct') {
    return {
      kind: 'struct',
      fields: args.map((argument, index) => {
        const dataType = inferAstExpressionType(argument, scope, context, environment);
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
      const dataType = inferAstExpressionType(value, scope, context, environment);
      fields.push(virtualColumn(name, dataTypeFamily(dataType), '', dataType));
    }
    return { kind: 'struct', fields };
  }
  if (['lower', 'upper', 'lcase', 'ucase', 'trim', 'ltrim', 'rtrim', 'concat', 'concat_ws', 'substring', 'substr'].includes(normalizedFunction)) {
    return dataTypeFromFamily('string');
  }
  if (normalizedFunction === 'split') return { kind: 'array', elementType: dataTypeFromFamily('string') };
  if (normalizedFunction === 'array') {
    return { kind: 'array', elementType: args[0] ? inferAstExpressionType(args[0], scope, context, environment) : UNKNOWN_DATA_TYPE };
  }
  if (normalizedFunction === 'map') {
    return {
      kind: 'map',
      keyType: args[0] ? inferAstExpressionType(args[0], scope, context, environment) : UNKNOWN_DATA_TYPE,
      valueType: args[1] ? inferAstExpressionType(args[1], scope, context, environment) : UNKNOWN_DATA_TYPE,
    };
  }
  if (['element_at', 'try_element_at'].includes(normalizedFunction) && args[0]) {
    const container = inferAstExpressionType(args[0], scope, context, environment);
    if (container.kind === 'array') return container.elementType;
    if (container.kind === 'map') return container.valueType;
  }
  if (node.kind === 'case') {
    const candidates = astChildren(node, 'ifs').flatMap((branch) => {
      const result = astChild(branch, 'true');
      return result ? [inferAstExpressionType(result, scope, context, environment)] : [];
    });
    const fallback = astChild(node, 'default');
    if (fallback) candidates.push(inferAstExpressionType(fallback, scope, context, environment));
    return commonAstDataType(candidates);
  }
  if (['coalesce', 'ifnull', 'nvl', 'greatest', 'least'].includes(normalizedFunction)) {
    return commonAstDataType(args.map((argument) => inferAstExpressionType(argument, scope, context, environment)));
  }
  if (normalizedFunction === 'if') {
    return commonAstDataType(args.slice(1).map((argument) => inferAstExpressionType(argument, scope, context, environment)));
  }
  if (['add', 'sub', 'mul', 'div', 'intDiv', 'mod'].includes(node.kind)) return dataTypeFromFamily('number');
  if (['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'is', 'in', 'between'].includes(node.kind)) {
    return dataTypeFromFamily('boolean');
  }
  return UNKNOWN_DATA_TYPE;
}

function validateAstHigherOrderExpression(
  node: SqlAstNode,
  scope: AstScope,
  ctes: ReadonlyMap<string, RelationBinding>,
  context: AstModelContext,
  environment: AstTypeEnvironment,
): boolean {
  const name = normalizeBareIdentifier(node.name || node.kind, context.dialect).replace(/^!/u, '');
  const invocations = astHigherOrderInvocations(node, name, scope, context, environment);
  if (!invocations) return false;
  forEachAstChild(node, (child) => {
    if (child.kind !== 'lambda') validateAstExpression(child, scope, ctes, context, environment);
  });
  for (const invocation of invocations) {
    const lambdaEnvironment = new Map(environment);
    const parameters = astChildren(invocation.lambda, 'expressions');
    parameters.forEach((parameter, index) => {
      lambdaEnvironment.set(
        normalizeBareIdentifier(parameter.name, context.dialect),
        invocation.parameterTypes[index] ?? UNKNOWN_DATA_TYPE,
      );
    });
    const body = astChild(invocation.lambda, 'this');
    if (body) validateAstExpression(body, scope, ctes, context, lambdaEnvironment);
  }
  return true;
}

interface AstLambdaInvocation {
  readonly lambda: SqlAstNode;
  readonly parameterTypes: readonly SqlDataType[];
}

function astHigherOrderInvocations(
  node: SqlAstNode,
  name: string,
  scope: AstScope | undefined,
  context: AstModelContext,
  environment: AstTypeEnvironment,
): AstLambdaInvocation[] | undefined {
  const args = astChildren(node, 'expressions');
  const dedicatedInput = astChild(node, 'this');
  const input = dedicatedInput ?? args[0];
  const inputType = input ? inferAstExpressionType(input, scope, context, environment) : UNKNOWN_DATA_TYPE;
  const elementType = inputType.kind === 'array' ? inputType.elementType : UNKNOWN_DATA_TYPE;
  const mapKeyType = inputType.kind === 'map' ? inputType.keyType : UNKNOWN_DATA_TYPE;
  const mapValueType = inputType.kind === 'map' ? inputType.valueType : UNKNOWN_DATA_TYPE;
  const dedicatedLambda = astChild(node, 'expression');
  if (name === 'transform' || name === 'arrayfilter' || name === 'filter') {
    const lambda = dedicatedLambda ?? args[1];
    return lambda ? [{ lambda, parameterTypes: [elementType] }] : [];
  }
  if (name === 'reduce' || name === 'aggregate') {
    const initial = astChild(node, 'initial') ?? args[1];
    const stateType = initial ? inferAstExpressionType(initial, scope, context, environment) : UNKNOWN_DATA_TYPE;
    const merge = astChild(node, 'merge') ?? args[2];
    const finish = astChild(node, 'finish') ?? args[3];
    return [
      ...(merge ? [{ lambda: merge, parameterTypes: [stateType, elementType] }] : []),
      ...(finish ? [{ lambda: finish, parameterTypes: [stateType] }] : []),
    ];
  }
  if (name === 'zip_with') {
    const rightType = args[1] ? inferAstExpressionType(args[1], scope, context, environment) : UNKNOWN_DATA_TYPE;
    const lambda = args[2];
    return lambda ? [{ lambda, parameterTypes: [elementType, rightType.kind === 'array' ? rightType.elementType : UNKNOWN_DATA_TYPE] }] : [];
  }
  if (name === 'map_zip_with') {
    const rightType = args[1] ? inferAstExpressionType(args[1], scope, context, environment) : UNKNOWN_DATA_TYPE;
    const lambda = args[2];
    return lambda ? [{
      lambda,
      parameterTypes: [
        mapKeyType,
        mapValueType,
        rightType.kind === 'map' ? rightType.valueType : UNKNOWN_DATA_TYPE,
      ],
    }] : [];
  }
  if (['transform_keys', 'transform_values', 'map_filter'].includes(name)) {
    const lambda = args[1];
    return lambda ? [{ lambda, parameterTypes: [mapKeyType, mapValueType] }] : [];
  }
  if (name === 'exists' || name === 'forall') {
    const lambda = args[1];
    return lambda ? [{ lambda, parameterTypes: [elementType] }] : [];
  }
  if (name === 'array_sort' && args[1]) {
    return [{ lambda: args[1], parameterTypes: [elementType, elementType] }];
  }
  return undefined;
}

function inferAstHigherOrderType(
  node: SqlAstNode,
  name: string,
  scope: AstScope | undefined,
  context: AstModelContext,
  environment: AstTypeEnvironment,
): SqlDataType | undefined {
  const invocations = astHigherOrderInvocations(node, name, scope, context, environment);
  if (!invocations) return undefined;
  const args = astChildren(node, 'expressions');
  const input = astChild(node, 'this') ?? args[0];
  const inputType = input ? inferAstExpressionType(input, scope, context, environment) : UNKNOWN_DATA_TYPE;
  const inferLambda = (invocation: AstLambdaInvocation): SqlDataType => {
    const lambdaEnvironment = new Map(environment);
    astChildren(invocation.lambda, 'expressions').forEach((parameter, index) => {
      lambdaEnvironment.set(normalizeBareIdentifier(parameter.name, context.dialect), invocation.parameterTypes[index] ?? UNKNOWN_DATA_TYPE);
    });
    const body = astChild(invocation.lambda, 'this');
    return body ? inferAstExpressionType(body, scope, context, lambdaEnvironment) : UNKNOWN_DATA_TYPE;
  };
  if (name === 'transform' || name === 'zip_with') {
    return { kind: 'array', elementType: invocations[0] ? inferLambda(invocations[0]) : UNKNOWN_DATA_TYPE };
  }
  if (name === 'arrayfilter' || name === 'filter' || name === 'array_sort') return inputType;
  if (name === 'exists' || name === 'forall') return dataTypeFromFamily('boolean');
  if (name === 'reduce' || name === 'aggregate') {
    const finish = invocations[1];
    if (finish) return inferLambda(finish);
    const initial = astChild(node, 'initial') ?? args[1];
    return initial ? inferAstExpressionType(initial, scope, context, environment) : UNKNOWN_DATA_TYPE;
  }
  if (name === 'map_filter') return inputType;
  if (name === 'map_zip_with') {
    return inputType.kind === 'map'
      ? { kind: 'map', keyType: inputType.keyType, valueType: invocations[0] ? inferLambda(invocations[0]) : UNKNOWN_DATA_TYPE }
      : UNKNOWN_DATA_TYPE;
  }
  if (name === 'transform_keys') {
    return inputType.kind === 'map'
      ? { kind: 'map', keyType: invocations[0] ? inferLambda(invocations[0]) : UNKNOWN_DATA_TYPE, valueType: inputType.valueType }
      : UNKNOWN_DATA_TYPE;
  }
  if (name === 'transform_values') {
    return inputType.kind === 'map'
      ? { kind: 'map', keyType: inputType.keyType, valueType: invocations[0] ? inferLambda(invocations[0]) : UNKNOWN_DATA_TYPE }
      : UNKNOWN_DATA_TYPE;
  }
  return UNKNOWN_DATA_TYPE;
}

function commonAstDataType(types: readonly SqlDataType[]): SqlDataType {
  const known = types.filter((type) => type.kind !== 'unknown');
  if (known.length === 0) return UNKNOWN_DATA_TYPE;
  const first = known[0]!;
  return known.every((type) => areDataTypesCompatible(first, type)) ? first : UNKNOWN_DATA_TYPE;
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
    if (!areDataTypesCompatible(columnDataType(expected, context.dialect), columnDataType(actual, context.dialect))) {
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
      if (expected && !areDataTypesCompatible(columnDataType(expected, context.dialect), actualType)) {
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
  const parts = astColumnPath(node);
  const text = parts.join('.');
  return {
    text,
    parts,
    start: node.start,
    end: node.end,
    isFunction: false,
  };
}

function astColumnQualifier(node: SqlAstNode): string {
  return astColumnPath(node).slice(0, -1).join('.');
}

function astColumnPath(node: SqlAstNode): string[] {
  const parts = ['catalog', 'db', 'table', 'this'].flatMap((key) => {
    const part = astChild(node, key);
    return part?.name ? [part.name] : [];
  });
  return parts.length > 0 ? parts : (node.name ? [node.name] : []);
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
  if (node.kind === 'columnDef') {
    const identifier = astChild(node, 'this');
    const dataType = astChild(node, 'kind');
    return identifier?.name && dataType ? `${identifier.name}:${astDataTypeText(dataType)}` : '';
  }
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

function deriveQueryColumns(
  text: string,
  dialect: SqlDialect,
  snapshot: SchemaSnapshot,
  placeholders: readonly RegExp[],
): SchemaColumn[] {
  const statement = parseSqlAst(text, dialect, placeholders)?.statements[0];
  return statement ? deriveAstStatementColumns(text, dialect, snapshot, placeholders, statement) : [];
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

function areTypesCompatible(target: SqlTypeFamily, source: SqlTypeFamily): boolean {
  if (target === 'unknown' || source === 'unknown' || target === source) return true;
  return (target === 'date' && source === 'time') || (target === 'time' && source === 'date');
}

function areDataTypesCompatible(target: SqlDataType, source: SqlDataType): boolean {
  if (target.kind === 'unknown' || source.kind === 'unknown') return true;
  if (target.kind === 'scalar' && source.kind === 'scalar') {
    return areTypesCompatible(target.family, source.family);
  }
  if (target.kind === 'array' && source.kind === 'array') {
    return areDataTypesCompatible(target.elementType, source.elementType);
  }
  if (target.kind === 'map' && source.kind === 'map') {
    return areDataTypesCompatible(target.keyType, source.keyType)
      && areDataTypesCompatible(target.valueType, source.valueType);
  }
  if (target.kind === 'struct' && source.kind === 'struct') {
    return target.fields.length === source.fields.length
      && target.fields.every((field, index) => {
        const actual = source.fields[index];
        return actual
          ? areDataTypesCompatible(columnDataType(field, 'generic'), columnDataType(actual, 'generic'))
          : false;
      });
  }
  return false;
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

function bindingMatchesExactQualifier(binding: RelationBinding, qualifier: string, dialect: SqlDialect): boolean {
  const normalized = normalizeQualifiedName(qualifier, dialect);
  return binding.aliases.some((alias) => alias === normalized);
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

function deduplicateSemanticIssues(issues: readonly SqlSemanticIssue[]): SqlSemanticIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.start}:${issue.end}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
