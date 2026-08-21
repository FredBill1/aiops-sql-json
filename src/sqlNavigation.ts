import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import type { SqlSchemaService } from './schemaService';
import { getSqlDocumentContext, type SqlDocumentContext } from './sqlDocumentContext';
import {
  CURRENT_SQL_DOCUMENT_SOURCE,
  formatSqlDataType,
  getSqlSymbolAtOffset,
  type SchemaColumn,
  type SqlSymbolDefinition,
  type SqlSymbolResolution,
} from './sqlSchemaCore';

export class SqlHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly jsonServices: JsonServiceManager,
    private readonly schemas: SqlSchemaService,
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const configuration = getExtensionConfiguration(document.uri);
    if (document.languageId === 'sql' && !configuration.plainSqlEnabled) return undefined;
    const context = getSqlDocumentContext(document, position, this.jsonServices, configuration);
    if (!context) return undefined;
    const snapshot = await this.schemas.getSchema(document.uri, configuration, false);
    if (token.isCancellationRequested) return undefined;
    const symbol = getSqlSymbolAtOffset(
      context.sqlText,
      context.sqlOffset,
      configuration.dialect,
      configuration.placeholderPatterns,
      snapshot,
      configuration.udfs,
    );
    if (!symbol) return undefined;
    const contents = renderSqlHover(symbol);
    return new vscode.Hover(contents, context.toDocumentRange(symbol.reference.start, symbol.reference.end));
  }
}

export class SqlDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly jsonServices: JsonServiceManager,
    private readonly schemas: SqlSchemaService,
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.DefinitionLink[] | undefined> {
    const configuration = getExtensionConfiguration(document.uri);
    if (document.languageId === 'sql' && !configuration.plainSqlEnabled) return undefined;
    const context = getSqlDocumentContext(document, position, this.jsonServices, configuration);
    if (!context) return undefined;
    const snapshot = await this.schemas.getSchema(document.uri, configuration, true);
    if (token.isCancellationRequested) return undefined;
    const symbol = getSqlSymbolAtOffset(
      context.sqlText,
      context.sqlOffset,
      configuration.dialect,
      configuration.placeholderPatterns,
      snapshot,
      configuration.udfs,
    );
    if (!symbol || symbol.definitions.length === 0) return undefined;
    const originSelectionRange = context.toDocumentRange(symbol.reference.start, symbol.reference.end);
    const candidates = await Promise.all(symbol.definitions.map((definition) => definitionLink(
      definition,
      document,
      context,
      originSelectionRange,
    )));
    if (token.isCancellationRequested) return undefined;
    const links = deduplicateLinks(candidates.filter((link): link is vscode.DefinitionLink => Boolean(link)));
    return links.length > 0 ? links : undefined;
  }
}

function renderSqlHover(symbol: SqlSymbolResolution): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = false;
  markdown.appendCodeblock(symbolSignature(symbol), 'sql');
  const definition = symbol.definitions[0];
  if (definition) {
    markdown.appendMarkdown(`\nSource: ${sourceLabel(definition)}`);
  } else if (symbol.functionCategory) {
    markdown.appendMarkdown(`\nSource: ${symbol.functionCategory === 'udf'
      ? 'configured UDF'
      : `${symbol.dialect ?? 'SQL'} ${symbol.functionCatalogVersion ?? ''} built-in catalog`.replace(/\s+/gu, ' ').trim()}`);
  } else {
    markdown.appendMarkdown('\nSource: local SQL scope');
  }
  if (symbol.definitions.length > 1) {
    markdown.appendMarkdown(` (${symbol.definitions.length} definitions)`);
  }
  return markdown;
}

function symbolSignature(symbol: SqlSymbolResolution): string {
  if (symbol.relation) {
    const columns = symbol.relation.columns.slice(0, 20);
    const lines = columns.map((column) => `  ${column.name} ${columnType(column)}`);
    const omitted = symbol.relation.columns.length - columns.length;
    if (omitted > 0) lines.push(`  -- … ${omitted} more field${omitted === 1 ? '' : 's'}`);
    return `${symbol.relation.kind} ${symbol.qualifiedName ?? symbol.relation.name} (\n${lines.join(',\n')}\n)`;
  }
  const type = symbol.dataType ? formatSqlDataType(symbol.dataType, 4, 20) : symbol.type || 'UNKNOWN';
  if (symbol.functionCategory) {
    const category = symbol.functionCategory === 'udf' ? 'configured UDF' : `${symbol.dialect ?? 'SQL'} built-in function`;
    if (symbol.functionSignatures?.length) {
      const visible = symbol.functionSignatures.slice(0, 8).map((signature) => (
        signature.replace(/\s*->\s*.*$/u, ` -> ${type}`)
      ));
      const omitted = symbol.functionSignatures.length - visible.length;
      if (omitted > 0) visible.push(`-- … ${omitted} more overload${omitted === 1 ? '' : 's'}`);
      return `${category}\n${visible.join('\n')}`;
    }
    return `${category} ${symbol.name}(...) -> ${type}`;
  }
  return `${symbol.kind} ${symbol.qualifiedName ?? symbol.name}: ${type}`;
}

function columnType(column: SchemaColumn): string {
  return column.dataType ? formatSqlDataType(column.dataType, 4, 20) : column.type || column.typeFamily.toUpperCase();
}

function sourceLabel(definition: SqlSymbolDefinition): string {
  const source = definition.location.source;
  if (!source || source === CURRENT_SQL_DOCUMENT_SOURCE) return `local ${definition.kind}`;
  try {
    const uri = vscode.Uri.parse(source, true);
    return `\`${vscode.workspace.asRelativePath(uri, false)}\``;
  } catch {
    return `\`${source}\``;
  }
}

async function definitionLink(
  definition: SqlSymbolDefinition,
  currentDocument: vscode.TextDocument,
  context: SqlDocumentContext,
  originSelectionRange: vscode.Range,
): Promise<vscode.DefinitionLink | undefined> {
  const location = definition.location;
  if (!location.source || location.source === CURRENT_SQL_DOCUMENT_SOURCE) {
    return {
      originSelectionRange,
      targetUri: currentDocument.uri,
      targetRange: context.toDocumentRange(location.start, location.end),
      targetSelectionRange: context.toDocumentRange(location.selectionStart, location.selectionEnd),
    };
  }
  try {
    const targetUri = vscode.Uri.parse(location.source, true);
    const targetDocument = await vscode.workspace.openTextDocument(targetUri);
    return {
      originSelectionRange,
      targetUri,
      targetRange: safeDocumentRange(targetDocument, location.start, location.end),
      targetSelectionRange: safeDocumentRange(
        targetDocument,
        location.selectionStart,
        location.selectionEnd,
      ),
    };
  } catch {
    return undefined;
  }
}

function safeDocumentRange(document: vscode.TextDocument, start: number, end: number): vscode.Range {
  const length = document.getText().length;
  const safeStart = Math.max(0, Math.min(start, length));
  const safeEnd = Math.max(safeStart, Math.min(end, length));
  return new vscode.Range(document.positionAt(safeStart), document.positionAt(safeEnd));
}

function deduplicateLinks(links: readonly vscode.DefinitionLink[]): vscode.DefinitionLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const selection = link.targetSelectionRange ?? link.targetRange;
    const key = `${link.targetUri.toString()}:${selection.start.line}:${selection.start.character}:${selection.end.line}:${selection.end.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
