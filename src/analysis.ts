import * as vscode from 'vscode';
import type { Diagnostic as LspDiagnostic } from 'vscode-json-languageservice';

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
import { analyzeSqlSemantics, type SchemaSnapshot } from './sqlSchemaCore';

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
  schema?: SchemaSnapshot,
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
  ).filter((diagnostic) => !shouldSuppressJsonDiagnostic(projected, diagnostic)).map((diagnostic) => toVscodeDiagnostic(
    document,
    projected.textDocument,
    projected.projection,
    diagnostic,
  ));

  if (!configuration.allowAllMultilineStrings) {
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
    appendSqlDiagnostics(document, projected, configuration, regionAnalysis, diagnostics, schema);
  }
  return { diagnostics, regions };
}

function shouldSuppressJsonDiagnostic(
  projected: ProjectedJsonDocument,
  diagnostic: LspDiagnostic,
): boolean {
  if (!isSchemaDiagnostic(diagnostic)) {
    return false;
  }
  const start = projected.textDocument.offsetAt(diagnostic.range.start);
  const end = projected.textDocument.offsetAt(diagnostic.range.end);
  if (projected.placeholders.some((placeholder) => overlaps(
    start,
    end,
    placeholder.token.start,
    placeholder.token.end,
  ))) {
    return true;
  }
  return projected.dynamicKeyObjectOffsets.has(start);
}

function isSchemaDiagnostic(diagnostic: LspDiagnostic): boolean {
  return diagnostic.source !== 'json'
    && (diagnostic.code === undefined || diagnostic.code === 1 || diagnostic.code === 2);
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
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
  schema?: SchemaSnapshot,
): { diagnostics: vscode.Diagnostic[]; sql: SqlAnalysis } {
  const sql = analyzeSql(document.getText(), configuration.dialect, configuration.placeholderPatterns);
  const diagnostics = sql.issues.map((issue) => createDiagnostic(
    document,
    { start: issue.start, end: issue.end },
    issue.message,
    vscode.DiagnosticSeverity.Error,
    `${configuration.dialect} SQL`,
  ));
  if (shouldReportSchemaDiagnostics(configuration) && schema) {
    diagnostics.push(...analyzeSqlSemantics(
      document.getText(),
      configuration.dialect,
      configuration.placeholderPatterns,
      schema,
      configuration.udfs,
    ).map((issue) => createDiagnostic(
      document,
      issue,
      issue.message,
      semanticIssueSeverity(issue.severity),
      `${configuration.dialect} SQL schema`,
      issue.code,
    )));
  }
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
  schema?: SchemaSnapshot,
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

  if (shouldReportSchemaDiagnostics(configuration) && schema) {
    for (const issue of analyzeSqlSemantics(
      region.decoded.text,
      configuration.dialect,
      configuration.placeholderPatterns,
      schema,
      configuration.udfs,
    )) {
      const spans = mapDecodedRange(region.decoded, issue.start, issue.end);
      const span = {
        start: spans[0]?.start ?? region.originalRange.start,
        end: spans.at(-1)?.end ?? region.originalRange.end,
      };
      diagnostics.push(createDiagnostic(
        document,
        span,
        issue.message,
        semanticIssueSeverity(issue.severity),
        `${configuration.dialect} SQL schema`,
        issue.code,
      ));
    }
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

function semanticIssueSeverity(severity: 'error' | 'warning' | undefined): vscode.DiagnosticSeverity {
  return severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
}

function shouldReportSchemaDiagnostics(configuration: ExtensionConfiguration): boolean {
  return configuration.schemaValidationEnabled && !configuration.schemaValidationCompletionOnly;
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
