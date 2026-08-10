import * as vscode from 'vscode';

import type { ExtensionConfiguration } from './config';
import { toVscodeDiagnostic, spanToRange } from './lspConverters';
import {
  extractSqlRegions,
  findIllegalStringLineBreaks,
  findWordJoinLineBreaks,
  mapDecodedRange,
  type SqlJsonRegion,
} from './regions';
import type { ProjectedJsonDocument } from './jsonService';
import { analyzeSql, type SqlAnalysis } from './sql';

export interface RegionAnalysis {
  region: SqlJsonRegion;
  sql: SqlAnalysis;
}

export interface SqlJsonAnalysis {
  diagnostics: vscode.Diagnostic[];
  regions: RegionAnalysis[];
}

export async function analyzeSqlJsonDocument(
  document: vscode.TextDocument,
  projected: ProjectedJsonDocument,
  configuration: ExtensionConfiguration,
): Promise<SqlJsonAnalysis> {
  const regions = analyzeSqlJsonRegions(projected, configuration);
  const sqlRegions = regions.map((region) => region.region);
  const diagnostics = (
    await projected.service.doValidation(
      projected.textDocument,
      projected.jsonDocument,
      {
        comments: 'error',
        trailingCommas: 'error',
        schemaValidation: 'warning',
        schemaRequest: 'warning',
      },
    )
  ).map((diagnostic) => toVscodeDiagnostic(
    document,
    projected.textDocument,
    projected.projection,
    diagnostic,
  ));

  for (const lineBreak of findIllegalStringLineBreaks(projected.projection, projected.jsonDocument, sqlRegions)) {
    diagnostics.push(createDiagnostic(
      document,
      lineBreak,
      'Physical line breaks are allowed only in string values whose property names match aiopsSqlJson.keyPatterns.',
      vscode.DiagnosticSeverity.Error,
      'JSON',
      'illegal-multiline-string',
    ));
  }

  for (const lineBreak of findWordJoinLineBreaks(projected.projection, sqlRegions)) {
    diagnostics.push(createDiagnostic(
      document,
      lineBreak,
      'The platform removes this line break, so the adjacent SQL words will be concatenated. Add whitespace or indentation at the start of the next line.',
      vscode.DiagnosticSeverity.Warning,
      'AIOps SQL JSON',
      'joined-by-platform',
    ));
  }

  for (const regionAnalysis of regions) {
    appendSqlDiagnostics(document, projected, configuration, regionAnalysis, diagnostics);
  }
  return { diagnostics, regions };
}

export function analyzeSqlJsonRegions(
  projected: ProjectedJsonDocument,
  configuration: ExtensionConfiguration,
): RegionAnalysis[] {
  return findSqlRegions(projected, configuration).map((region) => ({
    region,
    sql: analyzeSql(region.decoded.text, configuration.dialect, configuration.placeholderPatterns),
  }));
}

export function analyzePlainSqlDocument(
  document: vscode.TextDocument,
  configuration: ExtensionConfiguration,
): { diagnostics: vscode.Diagnostic[]; sql: SqlAnalysis } {
  const sql = analyzeSql(document.getText(), configuration.dialect, configuration.placeholderPatterns);
  const diagnostics = sql.issues.map((issue) => createDiagnostic(
    document,
    { start: issue.start, end: issue.end },
    issue.message,
    vscode.DiagnosticSeverity.Error,
    `${configuration.dialect} SQL`,
  ));
  return { diagnostics, sql };
}

function findSqlRegions(
  projected: ProjectedJsonDocument,
  configuration: ExtensionConfiguration,
): SqlJsonRegion[] {
  // Kept in a helper to make the ordering explicit: JSON must be projected and
  // parsed before property/value relationships can be identified safely.
  return extractSqlRegions(projected.projection, projected.jsonDocument, configuration.keyPatterns);
}

function appendSqlDiagnostics(
  document: vscode.TextDocument,
  projected: ProjectedJsonDocument,
  configuration: ExtensionConfiguration,
  regionAnalysis: RegionAnalysis,
  diagnostics: vscode.Diagnostic[],
): void {
  const { region, sql } = regionAnalysis;
  for (const issue of sql.issues) {
    const spans = mapDecodedRange(region.decoded, issue.start, issue.end);
    const span = { start: spans[0]?.start ?? region.originalRange.start, end: spans.at(-1)?.end ?? region.originalRange.end };
    diagnostics.push(createDiagnostic(
      document,
      span,
      issue.message,
      vscode.DiagnosticSeverity.Error,
      `${configuration.dialect} SQL`,
    ));
  }

  for (const token of sql.tokens) {
    if (token.type !== 'comment' || !region.decoded.text.slice(token.start, token.end).trimStart().startsWith('--')) {
      continue;
    }
    const spans = mapDecodedRange(region.decoded, token.start, token.end);
    if (spans.length < 2) {
      continue;
    }
    const outerStart = spans[0]?.start ?? region.originalRange.start;
    const outerEnd = spans.at(-1)?.end ?? region.originalRange.end;
    for (const lineBreak of projected.projection.removedLineBreaks) {
      if (lineBreak.start > outerStart && lineBreak.end < outerEnd) {
        diagnostics.push(createDiagnostic(
          document,
          lineBreak,
          'After the platform removes line breaks, this `--` comment continues into the next physical line. Use a block comment or adjust the SQL.',
          vscode.DiagnosticSeverity.Warning,
          'AIOps SQL JSON',
          'line-comment-crosses-line',
        ));
      }
    }
  }
}

function createDiagnostic(
  document: vscode.TextDocument,
  span: { start: number; end: number },
  message: string,
  severity: vscode.DiagnosticSeverity,
  source: string,
  code?: string,
): vscode.Diagnostic {
  const safeSpan = ensureVisibleSpan(document, span);
  const diagnostic = new vscode.Diagnostic(spanToRange(document, safeSpan), message, severity);
  diagnostic.source = source;
  diagnostic.code = code;
  return diagnostic;
}

function ensureVisibleSpan(
  document: vscode.TextDocument,
  span: { start: number; end: number },
): { start: number; end: number } {
  if (span.end > span.start || document.getText().length === 0) {
    return span;
  }
  if (span.start < document.getText().length) {
    return { start: span.start, end: span.start + 1 };
  }
  return { start: Math.max(0, span.start - 1), end: span.start };
}
