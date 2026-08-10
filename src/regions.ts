import type { ASTNode, JSONDocument, StringASTNode } from 'vscode-json-languageservice';

import { matchesAnyGlob } from './patterns';
import type { OriginalSpan, RemovedLineBreak } from './projection';
import type { PlatformProjection } from './projection';

export interface DecodedSqlText {
  text: string;
  spans: readonly OriginalSpan[];
  fallbackOffset: number;
}

export interface SqlJsonRegion {
  key: string;
  node: StringASTNode;
  decoded: DecodedSqlText;
  originalRange: OriginalSpan;
}

export function extractSqlRegions(
  projection: PlatformProjection,
  jsonDocument: JSONDocument,
  keyPatterns: readonly RegExp[],
): SqlJsonRegion[] {
  const regions: SqlJsonRegion[] = [];
  walkAst(jsonDocument.root, (node) => {
    if (node.type !== 'property' || node.valueNode?.type !== 'string') {
      return;
    }
    const key = node.keyNode.value;
    if (!matchesAnyGlob(key, keyPatterns)) {
      return;
    }
    const valueNode = node.valueNode;
    const originalRange = projection.mapProjectedRange(valueNode.offset, valueNode.offset + valueNode.length);
    regions.push({
      key,
      node: valueNode,
      decoded: decodeJsonString(projection, valueNode),
      originalRange,
    });
  });
  return regions;
}

export function findIllegalStringLineBreaks(
  projection: PlatformProjection,
  jsonDocument: JSONDocument,
  regions: readonly SqlJsonRegion[],
): RemovedLineBreak[] {
  const strings: StringASTNode[] = [];
  walkAst(jsonDocument.root, (node) => {
    if (node.type === 'string') {
      strings.push(node);
    }
  });
  const allowed = new Set(regions.map((region) => region.node));

  return projection.removedLineBreaks.filter((lineBreak) => {
    const containing = strings
      .filter((node) => isInsideStringContent(lineBreak.projectedOffset, node))
      .sort((left, right) => left.length - right.length)[0];
    return containing !== undefined && !allowed.has(containing);
  });
}

export function findWordJoinLineBreaks(
  projection: PlatformProjection,
  regions: readonly SqlJsonRegion[],
): RemovedLineBreak[] {
  return projection.removedLineBreaks.filter((lineBreak) => {
    const belongsToSql = regions.some((region) => isInsideStringContent(lineBreak.projectedOffset, region.node));
    if (!belongsToSql) {
      return false;
    }
    const before = projection.originalText[lineBreak.start - 1] ?? '';
    const after = projection.originalText[lineBreak.end] ?? '';
    return isSqlWordCharacter(before) && isSqlWordCharacter(after);
  });
}

export function findSqlRegionAtProjectedOffset(
  regions: readonly SqlJsonRegion[],
  projectedOffset: number,
): SqlJsonRegion | undefined {
  return regions.find((region) => isInsideStringContent(projectedOffset, region.node));
}

export function mapDecodedRange(decoded: DecodedSqlText, start: number, end: number): OriginalSpan[] {
  const safeStart = Math.min(Math.max(start, 0), decoded.spans.length);
  const safeEnd = Math.min(Math.max(end, safeStart), decoded.spans.length);
  if (safeStart === safeEnd) {
    const fallback = decoded.spans[safeStart]?.start ?? decoded.spans[safeStart - 1]?.end ?? decoded.fallbackOffset;
    return [{ start: fallback, end: fallback }];
  }

  const merged: OriginalSpan[] = [];
  for (const span of decoded.spans.slice(safeStart, safeEnd)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.end === span.start) {
      previous.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function decodeJsonString(projection: PlatformProjection, node: StringASTNode): DecodedSqlText {
  const raw = projection.text.slice(node.offset, node.offset + node.length);
  const output: string[] = [];
  const spans: OriginalSpan[] = [];
  const contentStart = raw.startsWith('"') ? 1 : 0;
  const contentEnd = raw.endsWith('"') ? raw.length - 1 : raw.length;
  const fallbackOffset = projection.toOriginalOffset(node.offset + contentStart, 'start');

  let index = contentStart;
  while (index < contentEnd) {
    const character = raw[index] ?? '';
    if (character !== '\\') {
      output.push(character);
      spans.push(projection.mapProjectedRange(node.offset + index, node.offset + index + 1));
      index += 1;
      continue;
    }

    const escaped = raw[index + 1];
    if (escaped === 'u' && /^[0-9a-fA-F]{4}$/u.test(raw.slice(index + 2, index + 6))) {
      output.push(String.fromCharCode(Number.parseInt(raw.slice(index + 2, index + 6), 16)));
      spans.push(projection.mapProjectedRange(node.offset + index, node.offset + index + 6));
      index += 6;
      continue;
    }

    const escapeLength = escaped === undefined ? 1 : 2;
    output.push(decodeSimpleEscape(escaped));
    spans.push(projection.mapProjectedRange(node.offset + index, node.offset + index + escapeLength));
    index += escapeLength;
  }

  return { text: output.join(''), spans, fallbackOffset };
}

function decodeSimpleEscape(character: string | undefined): string {
  switch (character) {
    case 'b': return '\b';
    case 'f': return '\f';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case '"': return '"';
    case '\\': return '\\';
    case '/': return '/';
    default: return character ?? '\\';
  }
}

function isInsideStringContent(projectedOffset: number, node: StringASTNode): boolean {
  const start = node.offset + 1;
  const end = node.offset + Math.max(node.length - 1, 1);
  return projectedOffset >= start && projectedOffset <= end;
}

function isSqlWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(character);
}

function walkAst(node: ASTNode | undefined, visitor: (node: ASTNode) => void): void {
  if (!node) {
    return;
  }
  visitor(node);
  for (const child of node.children ?? []) {
    walkAst(child, visitor);
  }
}
