import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import type { SqlSchemaService } from './schemaService';
import { formatSqlFunctionSignature } from './sqlFunctionSignatures';
import { getSqlDocumentContext } from './sqlDocumentContext';
import type { RelationBinding, SchemaTable } from './sqlSchemaCore';
import type { SqlService } from './sqlService';
import type { SqlCompletionResult } from './sqlWorkerProtocol';
import { sqlDocumentSnapshot } from './sqlServiceContext';

interface CompletionContext {
  allFieldNames: readonly string[];
  toDocumentRange: (start: number, end: number) => vscode.Range;
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly jsonServices: JsonServiceManager,
    private readonly schemas: SqlSchemaService,
    private readonly sqlService: SqlService,
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
    const version = document.version;
    const generation = this.sqlService.generation;
    try {
      const snapshot = sqlDocumentSnapshot(document, configuration, documentContext.sqlText, documentContext.regionKey);
      const schema = await this.schemas.getSchema(document.uri, configuration);
      if (token.isCancellationRequested || document.isClosed || document.version !== version
        || this.sqlService.generation !== generation) return undefined;
      const result = await this.sqlService.completion(snapshot, documentContext.sqlOffset, {
        allSqlTexts: documentContext.allSqlTexts,
        schemaKey: this.schemas.getSchemaKey(schema),
        udfs: configuration.udfs,
      }, token);
      if (token.isCancellationRequested || document.isClosed || document.version !== version
        || this.sqlService.generation !== generation) return undefined;
      const context: CompletionContext = {
        allFieldNames: result.fields,
        toDocumentRange: documentContext.toDocumentRange,
      };
      const completion = buildCompletionItems(context, configuration, result);
      return new vscode.CompletionList(completion.items, completion.prefix.length === 0);
    } catch {
      return undefined;
    }
  }

}

function buildCompletionItems(
  context: CompletionContext,
  configuration: ReturnType<typeof getExtensionConfiguration>,
  result: SqlCompletionResult,
): { items: vscode.CompletionItem[]; prefix: string } {
  const { word, prefix, casingPrefix } = result.context;
  const range = context.toDocumentRange(word.start, word.end);
  const catalog = result.catalog;
  const functionByName = new Map(catalog.functionDefinitions.flatMap((definition) => [
    [definition.name.toLocaleLowerCase(), definition] as const,
    ...definition.aliases.map((alias) => [alias.toLocaleLowerCase(), definition] as const),
  ]));
  const syntaxTypes = new Set(result.syntaxTypes);
  const relationContext = syntaxTypes.has('table') || syntaxTypes.has('view');
  const expressionContext = !relationContext && (
    syntaxTypes.has('column')
    || syntaxTypes.has('function')
    || result.context.expressionContext
  );
  const items: vscode.CompletionItem[] = [];
  const contextualKeywords = result.keywords;
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
      const definition = functionByName.get(functionName.toLocaleLowerCase());
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
      item.insertText = result.context.nextCharacter === '('
        ? cased
        : new vscode.SnippetString(`${escapeSnippet(cased)}($0)`);
      items.push(item);
    }
  }

  if (configuration.schemaValidationEnabled) {
    appendSchemaItems(items, context, result, expressionContext, relationContext, prefix, range);
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
  result: SqlCompletionResult,
  expressionContext: boolean,
  relationContext: boolean,
  prefix: string,
  range: vscode.Range,
): void {
  const effectiveSnapshot = result.schema;
  if (relationContext) {
    const qualifier = result.context.qualifier;
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
  const scope = result.scope;
  const qualifier = result.context.qualifier;
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

function relationMatches(relation: RelationBinding, qualifier: string): boolean {
  const lower = qualifier.toLocaleLowerCase();
  return relation.aliases.some((alias) => alias.toLocaleLowerCase() === lower || alias.split('.').at(-1) === lower);
}

function applyTypedCase(candidate: string, prefix: string): string {
  const firstLetter = /[A-Za-z]/u.exec(prefix)?.[0];
  if (!firstLetter) return candidate.toUpperCase();
  return firstLetter === firstLetter.toLocaleLowerCase() ? candidate.toLocaleLowerCase() : candidate.toUpperCase();
}

function matchesPrefix(candidate: string, prefix: string): boolean {
  return prefix.length === 0 || candidate.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
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
