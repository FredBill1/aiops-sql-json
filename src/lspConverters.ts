import * as vscode from 'vscode';
import type {
  CompletionItem as LspCompletionItem,
  Diagnostic as LspDiagnostic,
  Hover as LspHover,
  MarkedString,
  MarkupContent,
  Position as LspPosition,
  Range as LspRange,
  TextEdit as LspTextEdit,
} from 'vscode-json-languageservice';
import { InsertTextFormat } from 'vscode-json-languageservice';
import type { InsertReplaceEdit } from 'vscode-languageserver-types';

import type { OriginalSpan } from './projection';
import type { PlatformProjection } from './projection';
import type { TextDocument as LspTextDocument } from 'vscode-languageserver-textdocument';

export function mapLspRange(
  document: vscode.TextDocument,
  projectedDocument: LspTextDocument,
  projection: PlatformProjection,
  range: LspRange,
): vscode.Range {
  const start = projectedDocument.offsetAt(range.start);
  const end = projectedDocument.offsetAt(range.end);
  return spanToRange(document, projection.mapProjectedRange(start, end));
}

export function spanToRange(document: vscode.TextDocument, span: OriginalSpan): vscode.Range {
  const start = Math.min(Math.max(span.start, 0), document.getText().length);
  const end = Math.min(Math.max(span.end, start), document.getText().length);
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

export function toVscodeDiagnostic(
  document: vscode.TextDocument,
  projectedDocument: LspTextDocument,
  projection: PlatformProjection,
  diagnostic: LspDiagnostic,
): vscode.Diagnostic {
  const result = new vscode.Diagnostic(
    mapLspRange(document, projectedDocument, projection, diagnostic.range),
    typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
    toDiagnosticSeverity(diagnostic.severity),
  );
  result.source = diagnostic.source ?? 'JSON';
  if (diagnostic.code !== undefined) {
    result.code = diagnostic.code;
  }
  return result;
}

export function toVscodeCompletionItem(
  document: vscode.TextDocument,
  projectedDocument: LspTextDocument,
  projection: PlatformProjection,
  item: LspCompletionItem,
): vscode.CompletionItem {
  const result = new vscode.CompletionItem(item.label, toCompletionItemKind(item.kind));
  result.detail = item.detail;
  result.documentation = toDocumentation(item.documentation);
  result.sortText = item.sortText;
  result.filterText = item.filterText;
  result.preselect = item.preselect;
  result.commitCharacters = item.commitCharacters;

  if (item.textEdit) {
    applyCompletionTextEdit(result, document, projectedDocument, projection, item.textEdit, item.insertTextFormat);
  } else if (item.insertText !== undefined) {
    result.insertText = item.insertTextFormat === InsertTextFormat.Snippet
      ? new vscode.SnippetString(item.insertText)
      : item.insertText;
  }

  result.additionalTextEdits = item.additionalTextEdits?.map((edit) => new vscode.TextEdit(
    mapLspRange(document, projectedDocument, projection, edit.range),
    edit.newText,
  ));
  return result;
}

export function toVscodeHover(
  document: vscode.TextDocument,
  projectedDocument: LspTextDocument,
  projection: PlatformProjection,
  hover: LspHover,
): vscode.Hover {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  const markdown = contents.map(toMarkdownString);
  const range = hover.range ? mapLspRange(document, projectedDocument, projection, hover.range) : undefined;
  return new vscode.Hover(markdown, range);
}

export function originalPositionToLsp(
  document: vscode.TextDocument,
  position: vscode.Position,
  projectedDocument: LspTextDocument,
  projection: PlatformProjection,
): LspPosition {
  return projectedDocument.positionAt(projection.toProjectedOffset(document.offsetAt(position)));
}

function applyCompletionTextEdit(
  result: vscode.CompletionItem,
  document: vscode.TextDocument,
  projectedDocument: LspTextDocument,
  projection: PlatformProjection,
  edit: LspTextEdit | InsertReplaceEdit,
  insertTextFormat: InsertTextFormat | undefined,
): void {
  const newText = edit.newText;
  result.insertText = insertTextFormat === InsertTextFormat.Snippet ? new vscode.SnippetString(newText) : newText;
  if ('range' in edit) {
    result.range = mapLspRange(document, projectedDocument, projection, edit.range);
  } else {
    result.range = {
      inserting: mapLspRange(document, projectedDocument, projection, edit.insert),
      replacing: mapLspRange(document, projectedDocument, projection, edit.replace),
    };
  }
}

function toDiagnosticSeverity(severity: number | undefined): vscode.DiagnosticSeverity {
  switch (severity) {
    case 1: return vscode.DiagnosticSeverity.Error;
    case 2: return vscode.DiagnosticSeverity.Warning;
    case 3: return vscode.DiagnosticSeverity.Information;
    case 4: return vscode.DiagnosticSeverity.Hint;
    default: return vscode.DiagnosticSeverity.Error;
  }
}

function toCompletionItemKind(kind: number | undefined): vscode.CompletionItemKind {
  const adjusted = Math.max((kind ?? 1) - 1, 0);
  return adjusted as vscode.CompletionItemKind;
}

function toDocumentation(value: string | MarkupContent | undefined): string | vscode.MarkdownString | undefined {
  if (value === undefined || typeof value === 'string') {
    return value;
  }
  return new vscode.MarkdownString(value.value);
}

function toMarkdownString(value: MarkedString | MarkupContent): vscode.MarkdownString {
  if (typeof value === 'string') {
    return new vscode.MarkdownString(value);
  }
  if ('kind' in value) {
    return new vscode.MarkdownString(value.value);
  }
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(value.value, value.language);
  return markdown;
}
