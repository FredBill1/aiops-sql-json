import { getLanguageService, type ASTNode, type JSONDocument, type StringASTNode } from 'vscode-json-languageservice';
import { TextDocument as LspTextDocument } from 'vscode-languageserver-textdocument';

import type { ExtensionConfiguration } from './config';
import { projectJsonPlaceholders } from './jsonProjection';
import type { ProjectedJsonDocument } from './jsonService';
import { PlatformProjection } from './projection';
import { extractSqlRegions } from './regions';
import { parseSqlAstForFormatting } from './sqlAst';
import {
  formatSql,
  SqlFormattingError,
  type EditorFormattingOptions,
  type FormattedSql,
} from './sqlFormatting';

interface FormatAtom {
  start: number;
  end: number;
  sentinel: string;
  replacement: string;
}

export function formatSqlJson(
  projected: ProjectedJsonDocument,
  configuration: ExtensionConfiguration,
  editor: EditorFormattingOptions,
): string {
  if (!projected.jsonDocument.root || hasSyntaxErrors(projected.jsonDocument)) {
    throw new SqlFormattingError('The projected SQL JSON document contains JSON syntax errors.');
  }

  const regions = extractSqlRegions(
    projected.projection,
    projected.jsonDocument,
    configuration.keyPatterns,
  );
  const source = projected.textDocument.getText();
  const prefix = collisionFreePrefix(source);
  const externalPlaceholderRanges = uniqueExternalPlaceholderRanges(projected);
  const regionByRange = new Map(regions.map((region) => [rangeKey(region.node), region]));
  const atoms: FormatAtom[] = [];
  let atomIndex = 0;

  for (const range of externalPlaceholderRanges) {
    atoms.push(createAtom(
      projected,
      range.start,
      range.end,
      `${prefix}PLACEHOLDER_${atomIndex++}`,
    ));
  }

  walkAst(projected.jsonDocument.root, (node) => {
    if (node.type !== 'string' || externalPlaceholderRanges.some((range) => overlapsNode(range, node))) return;
    const region = regionByRange.get(rangeKey(node));
    const sentinel = `${prefix}${region ? 'SQL' : 'STRING'}_${atomIndex++}`;
    if (region) {
      const baseIndentLevel = sqlBaseIndentLevel(region.node, configuration.format.sqlJsonBaseIndent);
      const baseIndent = ' '.repeat(baseIndentLevel * editor.tabSize);
      let formatted: FormattedSql;
      try {
        formatted = formatSql(
          region.decoded.text,
          configuration.dialect,
          configuration.placeholderPatterns,
          configuration.format,
          {
            ...editor,
            insertSpaces: true,
            initialIndentColumns: baseIndent.length + 2,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const line = lineNumberAt(projected.projection.originalText, region.originalRange.start);
        throw new SqlFormattingError(
          `SQL property ${JSON.stringify(region.key)} at line ${line} cannot be formatted: ${message}`,
        );
      }
      atoms.push({
        start: node.offset,
        end: node.offset + node.length,
        sentinel,
        replacement: embeddedSqlLiteral(formatted, baseIndent, editor.eol),
      });
    } else {
      atoms.push(createAtom(projected, node.offset, node.offset + node.length, sentinel));
    }
  });

  const synthetic = replaceRanges(source, atoms);
  const syntheticDocument = LspTextDocument.create('inmemory://aiops-sql-json/format.json', 'json', 1, synthetic);
  const formattedSynthetic = applyTextEdits(
    syntheticDocument,
    projected.service.format(syntheticDocument, undefined, {
      tabSize: editor.tabSize,
      insertSpaces: editor.insertSpaces,
      insertFinalNewline: hasFinalLineBreak(projected.projection.originalText),
      keepLines: false,
    }),
  ).replace(/\n/gu, editor.eol);

  let restored = formattedSynthetic;
  for (const atom of atoms) {
    const needle = JSON.stringify(atom.sentinel);
    if (!restored.includes(needle)) {
      throw new SqlFormattingError('The JSON formatter lost a protected string or placeholder sentinel.');
    }
    restored = restored.replace(needle, atom.replacement);
  }
  validateFormattedDocument(restored, regions.length, configuration);
  return restored;
}

function createAtom(
  projected: ProjectedJsonDocument,
  start: number,
  end: number,
  sentinel: string,
): FormatAtom {
  const original = projected.projection.mapProjectedRange(start, end);
  return {
    start,
    end,
    sentinel,
    replacement: projected.projection.originalText.slice(original.start, original.end),
  };
}

function uniqueExternalPlaceholderRanges(
  projected: ProjectedJsonDocument,
): Array<{ start: number; end: number }> {
  const seen = new Set<string>();
  return projected.placeholders.flatMap((placeholder) => {
    if (placeholder.kind === 'string') return [];
    const key = `${placeholder.token.start}:${placeholder.token.end}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...placeholder.token }];
  });
}

function replaceRanges(source: string, atoms: readonly FormatAtom[]): string {
  let result = source;
  const sorted = [...atoms].sort((left, right) => right.start - left.start || right.end - left.end);
  for (const atom of sorted) {
    result = `${result.slice(0, atom.start)}${JSON.stringify(atom.sentinel)}${result.slice(atom.end)}`;
  }
  return result;
}

function embeddedSqlLiteral(formatted: FormattedSql, baseIndent: string, eol: string): string {
  const encodedLines = formatted.lines.map((line) => {
    const encoded = JSON.stringify(line.text).slice(1, -1);
    return `${baseIndent}${encoded}${line.semanticBreakAfter ? '\\n' : ''}`;
  });
  return `"${eol}${encodedLines.join(eol)}"`;
}

function sqlBaseIndentLevel(node: StringASTNode, configured: number | 'auto'): number {
  if (configured !== 'auto') return configured;
  let containers = 0;
  let current: ASTNode | undefined = node.parent;
  while (current) {
    if (current.type === 'object' || current.type === 'array') containers += 1;
    current = current.parent;
  }
  return containers + 1;
}

function applyTextEdits(
  document: LspTextDocument,
  edits: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[],
): string {
  let result = document.getText();
  const offsetEdits = edits.map((edit) => ({
    start: document.offsetAt(edit.range.start),
    end: document.offsetAt(edit.range.end),
    newText: edit.newText,
  })).sort((left, right) => right.start - left.start || right.end - left.end);
  for (const edit of offsetEdits) {
    result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
  }
  return result;
}

function validateFormattedDocument(
  text: string,
  expectedRegionCount: number,
  configuration: ExtensionConfiguration,
): void {
  const projection = new PlatformProjection(text);
  const placeholders = configuration.allowPlaceholdersEverywhere
    ? projectJsonPlaceholders(projection.text, configuration.placeholderPatterns)
    : { text: projection.text, occurrences: [] };
  const document = LspTextDocument.create('inmemory://aiops-sql-json/validate.json', 'json', 1, placeholders.text);
  const service = getLanguageService({});
  const jsonDocument = service.parseJSONDocument(document);
  if (!jsonDocument.root || hasSyntaxErrors(jsonDocument)) {
    throw new SqlFormattingError('The formatted SQL JSON failed its JSON syntax round-trip check.');
  }
  const regions = extractSqlRegions(projection, jsonDocument, configuration.keyPatterns);
  if (regions.length !== expectedRegionCount) {
    throw new SqlFormattingError('The formatted SQL JSON changed the number of recognized SQL properties.');
  }
  for (const region of regions) {
    if (region.decoded.text.trim().length > 0 && !parseSqlAstForFormatting(
      region.decoded.text,
      configuration.dialect,
      configuration.placeholderPatterns,
    )) {
      throw new SqlFormattingError(`Formatted SQL property ${JSON.stringify(region.key)} failed AST validation.`);
    }
  }
}

function collisionFreePrefix(text: string): string {
  let prefix = '__AIOPS_SQL_JSON_FORMAT_';
  while (text.includes(prefix)) prefix += 'X';
  return prefix;
}

function rangeKey(node: StringASTNode): string {
  return `${node.offset}:${node.length}`;
}

function overlapsNode(range: { start: number; end: number }, node: StringASTNode): boolean {
  return range.start < node.offset + node.length && node.offset < range.end;
}

function hasFinalLineBreak(text: string): boolean {
  return /(?:\r\n|\r|\n)$/u.test(text);
}

function hasSyntaxErrors(document: JSONDocument): boolean {
  return ((document as unknown as { syntaxErrors?: readonly unknown[] }).syntaxErrors?.length ?? 0) > 0;
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r\n|\r|\n/u).length;
}

function walkAst(node: ASTNode | undefined, visitor: (node: ASTNode) => void): void {
  if (!node) return;
  visitor(node);
  for (const child of node.children ?? []) walkAst(child, visitor);
}
