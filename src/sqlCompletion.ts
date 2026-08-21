import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import type { SqlSchemaService } from './schemaService';
import { getSqlSuggestions } from './sql';
import { getSqlCatalog } from './sqlCatalog';
import { formatSqlFunctionSignature } from './sqlFunctionSignatures';
import { getSqlDocumentContext } from './sqlDocumentContext';
import {
  collectSqlFieldNames,
  getSqlSchemaAtOffset,
  getSqlScopeInfo,
  type RelationBinding,
  type SchemaSnapshot,
  type SchemaTable,
} from './sqlSchemaCore';

interface CompletionContext {
  sqlText: string;
  sqlOffset: number;
  allFieldNames: readonly string[];
  toDocumentRange: (start: number, end: number) => vscode.Range;
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly jsonServices: JsonServiceManager,
    private readonly schemas: SqlSchemaService,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionList | undefined> {
    const configuration = getExtensionConfiguration(document.uri);
    if (document.languageId === 'sql' && !configuration.plainSqlEnabled) {
      return undefined;
    }
    const documentContext = getSqlDocumentContext(document, position, this.jsonServices, configuration);
    if (!documentContext) return undefined;
    const context: CompletionContext = {
      sqlText: documentContext.sqlText,
      sqlOffset: documentContext.sqlOffset,
      allFieldNames: deduplicateFields(documentContext.allSqlTexts.flatMap((text) => (
        collectSqlFieldNames(text, configuration.dialect, configuration.placeholderPatterns)
      ))),
      toDocumentRange: documentContext.toDocumentRange,
    };
    const snapshot = await this.schemas.getSchema(document.uri, configuration);
    if (token.isCancellationRequested) {
      return undefined;
    }
    const completion = buildCompletionItems(context, configuration, snapshot);
    return new vscode.CompletionList(completion.items, completion.prefix.length === 0);
  }

}

function buildCompletionItems(
  context: CompletionContext,
  configuration: ReturnType<typeof getExtensionConfiguration>,
  snapshot: SchemaSnapshot,
): { items: vscode.CompletionItem[]; prefix: string } {
  const word = wordAt(context.sqlText, context.sqlOffset);
  const prefix = context.sqlText.slice(word.start, context.sqlOffset);
  const casingPrefix = prefix || previousWordInStatement(context.sqlText, word.start);
  const range = context.toDocumentRange(word.start, word.end);
  const suggestions = getSqlSuggestions(
    context.sqlText,
    context.sqlOffset,
    configuration.dialect,
    configuration.placeholderPatterns,
  );
  const catalog = getSqlCatalog(configuration.dialect);
  const syntaxTypes = new Set(suggestions?.syntax.map((item) => item.syntaxContextType.toString()) ?? []);
  const relationContext = syntaxTypes.has('table') || syntaxTypes.has('view');
  const expressionContext = !relationContext && (
    syntaxTypes.has('column')
    || syntaxTypes.has('function')
    || looksLikeExpressionContext(context.sqlText, context.sqlOffset)
  );
  const items: vscode.CompletionItem[] = [];
  const contextualKeywords = suggestions?.keywords ?? [];
  const keywordCandidates = prefix.length > 0
    ? deduplicateFields([...contextualKeywords, ...catalog.keywords])
    : contextualKeywords;
  const contextualSet = new Set(contextualKeywords.map((keyword) => keyword.toUpperCase()));

  for (const keyword of keywordCandidates) {
    if (!matchesPrefix(keyword, prefix)) continue;
    const cased = applyTypedCase(keyword, casingPrefix);
    const item = new vscode.CompletionItem(cased, vscode.CompletionItemKind.Keyword);
    item.range = range;
    item.insertText = cased;
    item.detail = `${configuration.dialect} SQL keyword`;
    item.sortText = `${contextualSet.has(keyword.toUpperCase()) ? '2' : '5'}-${keyword}`;
    items.push(item);
  }

  if (expressionContext) {
    const functionCandidates = deduplicateFields([...configuration.udfs, ...catalog.functions]);
    const udfSet = new Set(configuration.udfs.map((name) => name.toLocaleLowerCase()));
    for (const functionName of functionCandidates) {
      if (!matchesPrefix(functionName, prefix)) continue;
      const cased = applyTypedCase(functionName, casingPrefix);
      const item = new vscode.CompletionItem(cased, vscode.CompletionItemKind.Function);
      item.range = range;
      const definition = catalog.functionByName.get(functionName.toLocaleLowerCase());
      if (udfSet.has(functionName.toLocaleLowerCase())) {
        item.detail = 'User-defined SQL function';
      } else if (definition?.signatures[0]) {
        const overloads = definition.signatures.length - 1;
        item.detail = `${configuration.dialect} ${catalog.version}: ${formatSqlFunctionSignature(
          cased,
          definition.signatures[0],
        )}${overloads > 0 ? ` (+${overloads} overload${overloads === 1 ? '' : 's'})` : ''}`;
      } else {
        item.detail = `${configuration.dialect} ${catalog.version} SQL function`;
      }
      item.sortText = `1-${functionName}`;
      item.insertText = nextNonWhitespace(context.sqlText, word.end) === '('
        ? cased
        : new vscode.SnippetString(`${escapeSnippet(cased)}($0)`);
      items.push(item);
    }
  }

  if (configuration.schemaValidationEnabled) {
    appendSchemaItems(items, context, configuration, snapshot, expressionContext, relationContext, prefix, range);
  } else if (expressionContext) {
    for (const field of context.allFieldNames) {
      if (!matchesPrefix(field, prefix)) continue;
      const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Field);
      item.range = range;
      item.insertText = field;
      item.detail = 'Field seen in this file';
      item.sortText = `0-${field}`;
      items.push(item);
    }
  }
  return { items: deduplicateCompletionItems(items), prefix };
}

function appendSchemaItems(
  items: vscode.CompletionItem[],
  context: CompletionContext,
  configuration: ReturnType<typeof getExtensionConfiguration>,
  snapshot: SchemaSnapshot,
  expressionContext: boolean,
  relationContext: boolean,
  prefix: string,
  range: vscode.Range,
): void {
  const effectiveSnapshot = getSqlSchemaAtOffset(
    context.sqlText,
    context.sqlOffset,
    configuration.dialect,
    configuration.placeholderPatterns,
    snapshot,
    configuration.udfs,
  );
  if (relationContext) {
    const qualifier = qualifierBefore(context.sqlText, context.sqlOffset);
    for (const table of effectiveSnapshot.tables) {
      const completion = relationCompletion(table, prefix, qualifier);
      if (!completion) continue;
      const item = new vscode.CompletionItem(completion.label, vscode.CompletionItemKind.Class);
      item.range = range;
      item.insertText = completion.insertText;
      item.filterText = completion.filterText;
      item.detail = `${table.kind === 'view' ? 'View' : 'Table'} from SQL schema: ${table.name}`;
      item.sortText = `0-${table.name}`;
      items.push(item);
    }
  }
  if (!expressionContext) {
    return;
  }
  const scope = getSqlScopeInfo(
    context.sqlText,
    context.sqlOffset,
    configuration.dialect,
    configuration.placeholderPatterns,
    snapshot,
    configuration.udfs,
  );
  const qualifier = qualifierBefore(context.sqlText, context.sqlOffset);
  const relations = qualifier
    ? scope.relations.filter((relation) => relationMatches(relation, qualifier))
    : scope.relations;
  const offeredFieldNames = new Set<string>();
  const counts = new Map<string, number>();
  for (const relation of relations) {
    for (const column of relation.columns) {
      counts.set(column.normalizedName, (counts.get(column.normalizedName) ?? 0) + 1);
    }
  }
  for (const relation of relations) {
    for (const column of relation.columns) {
      if (!matchesPrefix(column.name, prefix)) continue;
      const ambiguous = !qualifier && (counts.get(column.normalizedName) ?? 0) > 1;
      const relationPrefix = relation.aliases[0]?.split('.').at(-1) ?? relation.name;
      const insertText = ambiguous ? `${relationPrefix}.${column.name}` : column.name;
      offeredFieldNames.add(column.name.toLocaleLowerCase());
      const item = new vscode.CompletionItem(
        ambiguous ? `${relationPrefix}.${column.name}` : column.name,
        vscode.CompletionItemKind.Field,
      );
      item.range = range;
      item.insertText = insertText;
      item.detail = column.type ? `${relation.name}.${column.name}: ${column.type}` : `${relation.name}.${column.name}`;
      item.sortText = `0-0-${column.name}`;
      items.push(item);
    }
  }
  const needsFallbackFields = !qualifier && (
    scope.relations.length === 0 || scope.relations.some((relation) => relation.unresolved)
  );
  if (!needsFallbackFields) {
    return;
  }
  for (const table of effectiveSnapshot.tables) {
    for (const column of table.columns) {
      const normalized = column.name.toLocaleLowerCase();
      if (offeredFieldNames.has(normalized) || !matchesPrefix(column.name, prefix)) continue;
      offeredFieldNames.add(normalized);
      const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
      item.range = range;
      item.insertText = column.name;
      item.detail = column.type ? `${table.name}.${column.name}: ${column.type}` : `${table.name}.${column.name}`;
      item.sortText = `0-1-${column.name}`;
      items.push(item);
    }
  }
  for (const field of context.allFieldNames) {
    const normalized = field.toLocaleLowerCase();
    if (offeredFieldNames.has(normalized) || !matchesPrefix(field, prefix)) continue;
    offeredFieldNames.add(normalized);
    const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Field);
    item.range = range;
    item.insertText = field;
    item.detail = 'Field seen in this file';
    item.sortText = `0-2-${field}`;
    items.push(item);
  }
}

function relationCompletion(
  table: SchemaTable,
  prefix: string,
  qualifier: string | undefined,
): { label: string; insertText: string; filterText: string } | undefined {
  const parts = splitCompletionQualifiedName(table.name);
  if (parts.length === 0) return undefined;
  if (qualifier) {
    const qualifierParts = splitCompletionQualifiedName(qualifier);
    if (qualifierParts.length === 0 || qualifierParts.length >= parts.length) return undefined;
    if (!qualifierParts.every((part, index) => completionIdentifierEquals(part, parts[index] ?? ''))) {
      return undefined;
    }
    const remainder = parts.slice(qualifierParts.length).join('.');
    return matchesPrefix(remainder, prefix)
      ? { label: remainder, insertText: remainder, filterText: remainder }
      : undefined;
  }
  const leafName = parts.at(-1) ?? table.name;
  const fullNameMatch = matchesPrefix(table.name, prefix);
  const leafNameMatch = matchesPrefix(leafName, prefix);
  if (!fullNameMatch && !leafNameMatch) return undefined;
  return {
    label: table.name,
    insertText: table.name,
    filterText: fullNameMatch ? table.name : leafName,
  };
}

function splitCompletionQualifiedName(value: string): string[] {
  const result: string[] = [];
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
      const part = value.slice(start, index).trim();
      if (part) result.push(part);
      start = index + 1;
    }
  }
  return result;
}

function completionIdentifierEquals(left: string, right: string): boolean {
  return unquoteCompletionIdentifier(left).toLocaleLowerCase()
    === unquoteCompletionIdentifier(right).toLocaleLowerCase();
}

function unquoteCompletionIdentifier(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('`') && trimmed.endsWith('`'))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

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
  while (start > 0 && isQualifierCharacter(text[start - 1] ?? '')) start -= 1;
  return text.slice(start, cursor);
}

function isQualifierCharacter(character: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(character) || '.`"[]'.includes(character);
}

function relationMatches(relation: RelationBinding, qualifier: string): boolean {
  const lower = qualifier.toLocaleLowerCase();
  return relation.aliases.some((alias) => alias.toLocaleLowerCase() === lower || alias.split('.').at(-1) === lower);
}

function looksLikeExpressionContext(text: string, offset: number): boolean {
  const before = text.slice(0, offset).toUpperCase();
  const lastClause = /\b(SELECT|WHERE|HAVING|ON|SET|VALUES|GROUP\s+BY|ORDER\s+BY)\b[^;]*$/u.exec(before);
  return Boolean(lastClause);
}

function applyTypedCase(candidate: string, prefix: string): string {
  const firstLetter = /[A-Za-z]/u.exec(prefix)?.[0];
  if (!firstLetter) return candidate.toUpperCase();
  return firstLetter === firstLetter.toLocaleLowerCase() ? candidate.toLocaleLowerCase() : candidate.toUpperCase();
}

function previousWordInStatement(text: string, offset: number): string {
  const statementStart = text.lastIndexOf(';', Math.max(0, offset - 1)) + 1;
  const words = text.slice(statementStart, offset).match(/[\p{L}_$][\p{L}\p{N}_$]*/gu);
  return words?.at(-1) ?? '';
}

function matchesPrefix(candidate: string, prefix: string): boolean {
  return prefix.length === 0 || candidate.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
}

function nextNonWhitespace(text: string, offset: number): string | undefined {
  return /\S/u.exec(text.slice(offset))?.[0];
}

function escapeSnippet(value: string): string {
  return value.replace(/[$}\\]/gu, '\\$&');
}

function deduplicateFields(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateCompletionItems(items: readonly vscode.CompletionItem[]): vscode.CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    const key = `${item.kind}:${label.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
