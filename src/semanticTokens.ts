import * as vscode from 'vscode';

import { getExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import { extractSqlRegions, mapDecodedRange } from './regions';
import type { SqlTokenType } from './sqlTypes';
import type { SqlService } from './sqlService';
import { sqlDocumentSnapshot } from './sqlServiceContext';

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

  constructor(private readonly jsonServices: JsonServiceManager, private readonly sqlService: SqlService) {}

  refresh(): void {
    this.changedEmitter.fire();
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    cancellation: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens> {
    const configuration = getExtensionConfiguration(document.uri);
    const version = document.version;
    const generation = this.sqlService.generation;
    const documentLength = document.getText().length;
    const pending: PendingToken[] = [];

    try {
      if (cancellation.isCancellationRequested) return new vscode.SemanticTokens(new Uint32Array());
      if (document.languageId === 'sql-json') {
        const projected = this.jsonServices.createDocument(document, configuration);
        const regions = extractSqlRegions(projected.projection, projected.jsonDocument, configuration.keyPatterns);
        const analyses = await Promise.all(regions.map(async (region) => ({
          region,
          tokens: await this.sqlService.tokens(sqlDocumentSnapshot(document, configuration,
            region.decoded.text, `region:${region.originalRange.start}`), cancellation),
        })));
        if (cancellation.isCancellationRequested || document.isClosed || document.version !== version
          || this.sqlService.generation !== generation) {
          return new vscode.SemanticTokens(new Uint32Array());
        }
        for (const analysis of analyses) {
          for (const token of analysis.tokens) {
            for (const span of mapDecodedRange(analysis.region.decoded, token.start, token.end)) {
              appendSplitRanges(document, documentLength, span.start, span.end, token.type, pending);
            }
          }
        }
      } else if (document.languageId === 'sql' && configuration.plainSqlEnabled) {
        const tokens = await this.sqlService.tokens(sqlDocumentSnapshot(document, configuration), cancellation);
        if (cancellation.isCancellationRequested || document.isClosed || document.version !== version
          || this.sqlService.generation !== generation) {
          return new vscode.SemanticTokens(new Uint32Array());
        }
        for (const token of tokens) {
          appendSplitRanges(document, documentLength, token.start, token.end, token.type, pending);
        }
      }
    } catch {
      return new vscode.SemanticTokens(new Uint32Array());
    }
    if (cancellation.isCancellationRequested || document.isClosed || document.version !== version
      || this.sqlService.generation !== generation) {
      return new vscode.SemanticTokens(new Uint32Array());
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
  documentLength: number,
  startOffset: number,
  endOffset: number,
  type: SqlTokenType,
  pending: PendingToken[],
): void {
  const safeStart = Math.min(Math.max(startOffset, 0), documentLength);
  const safeEnd = Math.min(Math.max(endOffset, safeStart), documentLength);
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
