import { parentPort } from 'node:worker_threads';

import { getLanguageService } from 'vscode-json-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { ExtensionConfiguration } from './config';
import { projectJsonPlaceholders } from './jsonProjection';
import { compileGlobs, compilePlaceholderPatterns } from './patterns';
import { PlatformProjection } from './projection';
import { analyzeSql, getSqlSuggestions } from './sql';
import { getSqlCatalog } from './sqlCatalog';
import { formatSql } from './sqlFormatting';
import { formatSqlJson } from './sqlJsonFormatting';
import {
  analyzeSqlSemantics, collectSqlFieldNames, createSchemaSnapshot, formatSqlDataType,
  getSqlSchemaAtOffset, getSqlScopeInfo, getSqlSymbolAtOffset, parseDdlSchema,
  type SchemaSnapshot,
} from './sqlSchemaCore';
import type { SqlSchemaRegistration, SqlWorkerRequest } from './sqlWorkerProtocol';
import { runSqlWorker } from './sqlWorkerRuntime';

const emptySchema: SchemaSnapshot = { tables: [], issues: [] };
// Snapshots stay here: their diagnostic WeakMap evidence must not cross a clone boundary.
const schemas = new Map<string, { revision: number; snapshot: SchemaSnapshot }>();

function registerSchema(registration: SqlSchemaRegistration): SchemaSnapshot {
  const existing = schemas.get(registration.key);
  if (existing?.revision === registration.revision) return existing.snapshot;
  const snapshot = createSchemaSnapshot(registration.sources.map(({ text, source }) => (
    parseDdlSchema(text, registration.dialect, source)
  )), registration.udfs);
  schemas.set(registration.key, { revision: registration.revision, snapshot });
  return snapshot;
}

function schemaFor(request: SqlWorkerRequest): SchemaSnapshot {
  if (!('schemaKey' in request) || !request.schemaKey) return emptySchema;
  if (request.schema) registerSchema(request.schema);
  const entry = schemas.get(request.schemaKey);
  if (!entry || entry.revision !== request.schemaRevision) throw new Error('SQL Schema registration is unavailable.');
  return entry.snapshot;
}

runSqlWorker((request) => {
  if (request.operation === 'clear') { schemas.clear(); return undefined; }
  if (request.operation === 'forgetSchema') { schemas.delete(request.key); return undefined; }
  if (request.operation === 'clearDocument') return undefined;
  if (request.operation === 'buildSchema') return registerSchema(request.schema);
  if (request.operation === 'tokens') throw new Error('Tokens belong to the lexical worker.');
  if (request.operation === 'formatJson') {
    const { snapshot, configuration, editor } = request;
    const placeholders = compilePlaceholderPatterns(configuration.placeholderSources);
    const projection = new PlatformProjection(snapshot.text);
    const projected = configuration.allowPlaceholdersEverywhere
      ? projectJsonPlaceholders(projection.text, placeholders.patterns)
      : { text: projection.text, occurrences: [] };
    const textDocument = TextDocument.create(snapshot.uri, 'json', snapshot.version, projected.text);
    const service = getLanguageService({});
    const jsonDocument = service.parseJSONDocument(textDocument);
    const extensionConfiguration: ExtensionConfiguration = {
      ...configuration,
      keyPatternSources: [...configuration.keyPatternSources], keyPatterns: compileGlobs(configuration.keyPatternSources),
      placeholderSources: [...configuration.placeholderSources], placeholderPatterns: placeholders.patterns,
      placeholderIssues: placeholders.issues, plainSqlEnabled: true,
      schemaValidationEnabled: false, schemaValidationCompletionOnly: false, schemaFileGlobs: [], udfs: [],
    };
    return formatSqlJson({
      projection, textDocument, jsonDocument, service, placeholders: projected.occurrences,
      dynamicKeyObjectOffsets: new Set(),
    }, extensionConfiguration, editor);
  }
  const { snapshot } = request;
  const placeholders = compilePlaceholderPatterns(snapshot.placeholderSources).patterns;
  if (request.operation === 'format') {
    return formatSql(snapshot.text, snapshot.dialect, placeholders, request.format, request.editor).text;
  }
  const schema = schemaFor(request);
  if (request.schemaKey) parentPort!.postMessage({ kind: 'schemaReady', id: request.id, epoch: request.epoch });
  const udfs = request.options.udfs ?? [];
  if (request.operation === 'analyze') {
    const sql = analyzeSql(snapshot.text, snapshot.dialect, placeholders);
    return {
      sql,
      semantics: request.options.validateSchema && sql.issues.length === 0
        ? analyzeSqlSemantics(snapshot.text, snapshot.dialect, placeholders, schema, udfs) : [],
    };
  }
  if (request.operation === 'completion') {
    const suggestions = getSqlSuggestions(snapshot.text, request.offset, snapshot.dialect, placeholders);
    const catalog = getSqlCatalog(snapshot.dialect);
    const word = wordAt(snapshot.text, request.offset);
    const prefix = snapshot.text.slice(word.start, request.offset);
    const syntaxTypes = suggestions?.syntax.map((suggestion) => suggestion.syntaxContextType.toString()) ?? [];
    const relationContext = syntaxTypes.includes('table') || syntaxTypes.includes('view');
    return {
      context: {
        word, prefix, casingPrefix: prefix || previousWordInStatement(snapshot.text, word.start),
        qualifier: qualifierBefore(snapshot.text, request.offset),
        nextCharacter: /\S/u.exec(snapshot.text.slice(word.end))?.[0],
        expressionContext: !relationContext && (syntaxTypes.includes('column') || syntaxTypes.includes('function')
          || looksLikeExpressionContext(snapshot.text, request.offset)),
      },
      keywords: suggestions?.keywords ?? [],
      syntaxTypes,
      fields: uniqueFieldNames((request.options.allSqlTexts ?? [snapshot.text]).flatMap((text) => (
        collectSqlFieldNames(text, snapshot.dialect, placeholders)
      ))),
      schema: getSqlSchemaAtOffset(snapshot.text, request.offset, snapshot.dialect, placeholders, schema, udfs),
      scope: getSqlScopeInfo(snapshot.text, request.offset, snapshot.dialect, placeholders, schema, udfs),
      catalog: {
        version: catalog.version, keywords: catalog.keywords, functions: catalog.functions,
        functionDefinitions: catalog.functionDefinitions,
      },
    };
  }
  const symbol = getSqlSymbolAtOffset(snapshot.text, request.offset, snapshot.dialect, placeholders, schema, udfs);
  if (!symbol) return undefined;
  return {
    ...symbol, type: symbol.dataType ? formatSqlDataType(symbol.dataType, 4, 20) : symbol.type || 'UNKNOWN',
    relation: symbol.relation ? {
      ...symbol.relation,
      columns: symbol.relation.columns.map((column) => ({
        ...column, type: column.dataType ? formatSqlDataType(column.dataType, 4, 20) : column.type || column.typeFamily.toUpperCase(),
      })),
    } : undefined,
  };
});

function wordAt(text: string, offset: number): { start: number; end: number } {
  let start = Math.min(Math.max(offset, 0), text.length);
  let end = start;
  while (start > 0 && /[\p{L}\p{N}_$]/u.test(text[start - 1] ?? '')) start -= 1;
  while (end < text.length && /[\p{L}\p{N}_$]/u.test(text[end] ?? '')) end += 1;
  return { start, end };
}

function qualifierBefore(text: string, offset: number): string | undefined {
  let cursor = offset;
  while (cursor > 0 && /[\p{L}\p{N}_$]/u.test(text[cursor - 1] ?? '')) cursor -= 1;
  if (text[cursor - 1] !== '.') return undefined;
  cursor -= 1;
  let start = cursor;
  while (start > 0 && (/[\p{L}\p{N}_$]/u.test(text[start - 1] ?? '') || '.`"[]'.includes(text[start - 1] ?? ''))) start -= 1;
  return text.slice(start, cursor);
}

function previousWordInStatement(text: string, offset: number): string {
  const statementStart = text.lastIndexOf(';', Math.max(0, offset - 1)) + 1;
  const words = text.slice(statementStart, offset).match(/[\p{L}_$][\p{L}\p{N}_$]*/gu);
  return words?.at(-1) ?? '';
}

function looksLikeExpressionContext(text: string, offset: number): boolean {
  const before = text.slice(0, offset).toUpperCase();
  return Boolean(/\b(SELECT|WHERE|HAVING|ON|SET|VALUES|GROUP\s+BY|ORDER\s+BY)\b[^;]*$/u.exec(before));
}

function uniqueFieldNames(fields: readonly string[]): string[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = field.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
