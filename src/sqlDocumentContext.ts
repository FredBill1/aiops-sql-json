import * as vscode from 'vscode';

import type { ExtensionConfiguration } from './config';
import type { JsonServiceManager } from './jsonService';
import {
  decodedOffsetAtOriginalOffset,
  extractSqlRegions,
  findSqlRegionAtProjectedOffset,
  mapDecodedRange,
  type DecodedSqlText,
} from './regions';

export interface SqlDocumentContext {
  sqlText: string;
  sqlOffset: number;
  allSqlTexts: readonly string[];
  toDocumentRange(start: number, end: number): vscode.Range;
}

export function getSqlDocumentContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  jsonServices: JsonServiceManager,
  configuration: ExtensionConfiguration,
): SqlDocumentContext | undefined {
  if (document.languageId === 'sql') {
    const text = document.getText();
    return {
      sqlText: text,
      sqlOffset: document.offsetAt(position),
      allSqlTexts: [text],
      toDocumentRange: (start, end) => new vscode.Range(
        document.positionAt(start),
        document.positionAt(end),
      ),
    };
  }
  if (document.languageId !== 'sql-json') return undefined;
  const projected = jsonServices.createDocument(document, configuration);
  const regions = extractSqlRegions(projected.projection, projected.jsonDocument, configuration.keyPatterns);
  const originalOffset = document.offsetAt(position);
  const projectedOffset = projected.projection.toProjectedOffset(originalOffset);
  const region = findSqlRegionAtProjectedOffset(regions, projectedOffset);
  if (!region) return undefined;
  return {
    sqlText: region.decoded.text,
    sqlOffset: decodedOffsetAtOriginalOffset(region.decoded, originalOffset),
    allSqlTexts: regions.map((candidate) => candidate.decoded.text),
    toDocumentRange: (start, end) => decodedRangeToDocumentRange(document, region.decoded, start, end),
  };
}

function decodedRangeToDocumentRange(
  document: vscode.TextDocument,
  decoded: DecodedSqlText,
  start: number,
  end: number,
): vscode.Range {
  const spans = mapDecodedRange(decoded, start, end);
  const first = spans[0];
  const last = spans.at(-1);
  if (!first || !last) {
    const fallback = document.positionAt(decoded.fallbackOffset);
    return new vscode.Range(fallback, fallback);
  }
  return new vscode.Range(document.positionAt(first.start), document.positionAt(last.end));
}
