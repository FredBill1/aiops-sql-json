import * as vscode from 'vscode';

import { analyzeSqlJsonRegions } from './analysis';
import { getExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import { mapDecodedRange } from './regions';
import { analyzeSql, type SqlTokenType } from './sql';

export const SEMANTIC_TOKEN_TYPES: SqlTokenType[] = [
  'comment',
  'string',
  'keyword',
  'number',
  'operator',
  'function',
  'variable',
];

export const SEMANTIC_TOKEN_LEGEND = new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES, []);

interface PendingToken {
  range: vscode.Range;
  type: SqlTokenType;
}

export class SqlSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this.changedEmitter.event;

  constructor(private readonly jsonServices: JsonServiceManager) {}

  refresh(): void {
    this.changedEmitter.fire();
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens> {
    const configuration = getExtensionConfiguration(document.uri);
    const pending: PendingToken[] = [];

    if (document.languageId === 'sql-json') {
      const projected = this.jsonServices.createDocument(document);
      const regions = analyzeSqlJsonRegions(projected, configuration);
      if (cancellation.isCancellationRequested) {
        return new vscode.SemanticTokens(new Uint32Array());
      }
      for (const regionAnalysis of regions) {
        for (const token of regionAnalysis.sql.tokens) {
          for (const span of mapDecodedRange(regionAnalysis.region.decoded, token.start, token.end)) {
            appendSplitRanges(document, span.start, span.end, token.type, pending);
          }
        }
      }
    } else if (document.languageId === 'sql' && configuration.plainSqlEnabled) {
      const sql = analyzeSql(document.getText(), configuration.dialect, configuration.placeholderPatterns);
      for (const token of sql.tokens) {
        appendSplitRanges(document, token.start, token.end, token.type, pending);
      }
    }

    pending.sort((left, right) => left.range.start.compareTo(right.range.start) || left.range.end.compareTo(right.range.end));
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKEN_LEGEND);
    let previousEnd: vscode.Position | undefined;
    for (const token of pending) {
      if (token.range.isEmpty || (previousEnd && token.range.start.isBefore(previousEnd))) {
        continue;
      }
      builder.push(token.range, token.type, []);
      previousEnd = token.range.end;
    }
    return builder.build();
  }

  dispose(): void {
    this.changedEmitter.dispose();
  }
}

function appendSplitRanges(
  document: vscode.TextDocument,
  startOffset: number,
  endOffset: number,
  type: SqlTokenType,
  pending: PendingToken[],
): void {
  const safeStart = Math.min(Math.max(startOffset, 0), document.getText().length);
  const safeEnd = Math.min(Math.max(endOffset, safeStart), document.getText().length);
  let start = document.positionAt(safeStart);
  const end = document.positionAt(safeEnd);
  while (start.line < end.line) {
    const lineEnd = document.lineAt(start.line).range.end;
    if (start.isBefore(lineEnd)) {
      pending.push({ range: new vscode.Range(start, lineEnd), type });
    }
    start = new vscode.Position(start.line + 1, 0);
  }
  if (start.isBefore(end)) {
    pending.push({ range: new vscode.Range(start, end), type });
  }
}
