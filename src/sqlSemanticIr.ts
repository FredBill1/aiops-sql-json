import type { EntityContext } from 'dt-sql-parser';
import type { ParserRuleContext, Token } from 'antlr4ng';

import { maskPlaceholders } from './patterns';
import { getSqlParser, type SqlDialect } from './sql';

export interface SemanticReference {
  kind: 'column' | 'function';
  text: string;
  start: number;
  end: number;
}

export interface SemanticFieldAccess {
  start: number;
  end: number;
  baseStart: number;
  baseEnd: number;
  fieldStart: number;
  fieldEnd: number;
  field: string;
}

export interface SemanticLateralView {
  start: number;
  end: number;
  functionName: string;
  functionStart: number;
  functionEnd: number;
  argumentStart: number;
  argumentEnd: number;
  tableAlias: string;
  outputAliases: readonly string[];
}

export interface SemanticPartitionColumn {
  name: string;
  type: string;
  start: number;
  end: number;
}

export interface SqlSemanticIr {
  references: readonly SemanticReference[];
  fieldAccesses: readonly SemanticFieldAccess[];
  lateralViews: readonly SemanticLateralView[];
  partitionColumns: readonly SemanticPartitionColumn[];
}

interface DialectParseTreeAdapter {
  embeddedColumnContext: RegExp;
  functionNameContext: RegExp;
  functionContextIncludesArguments?: boolean;
}

// The generated grammars use different context classes for the same semantic
// construct. Keeping that knowledge here prevents the resolver from depending
// on grammar-specific class names or from treating every identifier token as a
// column reference.
const DIALECT_ADAPTERS: Record<SqlDialect, DialectParseTreeAdapter> = {
  spark: {
    embeddedColumnContext: /^ColumnNamePathContext\d*$/u,
    functionNameContext: /^FunctionNameContext\d*$/u,
  },
  hive: {
    embeddedColumnContext: /^ColumnNamePathContext\d*$/u,
    functionNameContext: /^FunctionNameForInvokeContext\d*$/u,
  },
  flink: {
    embeddedColumnContext: /^ColumnReferenceContext\d*$/u,
    functionNameContext: /^FunctionNameWithParamsContext\d*$/u,
  },
  mysql: {
    embeddedColumnContext: /^ColumnNamePathContext\d*$/u,
    functionNameContext: /^FunctionNameContext\d*$/u,
  },
  postgresql: {
    embeddedColumnContext: /^ColumnNameContext\d*$/u,
    functionNameContext: /^FunctionNameContext\d*$/u,
  },
  trino: {
    embeddedColumnContext: /^ColumnReferenceContext\d*$/u,
    functionNameContext: /^FunctionNameContext\d*$/u,
  },
  impala: {
    embeddedColumnContext: /^(?:ColumnReference|ColumnNamePath)Context\d*$/u,
    functionNameContext: /^FunctionNamePathContext\d*$/u,
  },
  generic: {
    embeddedColumnContext: /^ColumnReferenceContext\d*$/u,
    functionNameContext: /^FunctionCallContext\d*$/u,
    functionContextIncludesArguments: true,
  },
};

interface ParseTreeNode {
  readonly constructor?: { readonly name?: string };
  readonly start?: Token;
  readonly stop?: Token;
  readonly children?: readonly ParseTreeNode[];
  readonly _base?: ParseTreeNode;
  readonly _field?: ParseTreeNode;
  readonly _fieldName?: ParseTreeNode;
  readonly _colName?: readonly ParseTreeNode[];
  readonly text?: string;
  columnType?: () => ParseTreeNode | null;
  expression?: () => ParseTreeNode[] | ParseTreeNode | null;
  tableAlias?: () => ParseTreeNode | null;
  viewName?: () => ParseTreeNode | null;
}

export function buildSqlSemanticIr(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  entities: readonly EntityContext[],
): SqlSemanticIr {
  const masked = maskPlaceholders(text, placeholders).text;
  let tree: ParserRuleContext;
  const parser = getSqlParser(dialect);
  try {
    tree = parser.parse(masked);
  } catch {
    return { references: [], fieldAccesses: [], lateralViews: [], partitionColumns: [] };
  }

  const adapter = DIALECT_ADAPTERS[dialect];
  const references: SemanticReference[] = [];
  const fieldAccesses: SemanticFieldAccess[] = [];
  const lateralViews: SemanticLateralView[] = [];
  const partitionColumns: SemanticPartitionColumn[] = [];

  for (const entity of flattenEntities(entities)) {
    if (entity.entityContextType !== 'column' || !('declareType' in entity) || entity.declareType !== 0) {
      continue;
    }
    if (entity.position.endIndex < entity.position.startIndex) continue;
    references.push({
      kind: nextNonWhitespace(text, entity.position.endIndex + 1) === '(' ? 'function' : 'column',
      text: text.slice(entity.position.startIndex, entity.position.endIndex + 1),
      start: entity.position.startIndex,
      end: entity.position.endIndex + 1,
    });
  }

  visitTree(tree as ParseTreeNode, (node) => {
    const contextName = node.constructor?.name ?? '';
    const span = nodeSpan(node, text.length);
    if (!span) return;

    if (adapter.embeddedColumnContext.test(contextName)) {
      references.push({ kind: 'column', text: text.slice(span.start, span.end), ...span });
    }
    if (adapter.functionNameContext.test(contextName)) {
      const raw = text.slice(span.start, span.end);
      const name = adapter.functionContextIncludesArguments ? raw.slice(0, raw.indexOf('(')).trim() : raw;
      if (name) {
        references.push({
          kind: 'function',
          text: name,
          start: span.start,
          end: span.start + name.length,
        });
      }
    }

    const fieldNode = node._fieldName ?? node._field;
    const baseSpan = node._base ? nodeSpan(node._base, text.length) : undefined;
    const fieldSpan = fieldNode ? nodeSpan(fieldNode, text.length) : undefined;
    if (baseSpan && fieldSpan && fieldSpan.start >= baseSpan.end) {
      fieldAccesses.push({
        ...span,
        baseStart: baseSpan.start,
        baseEnd: baseSpan.end,
        fieldStart: fieldSpan.start,
        fieldEnd: fieldSpan.end,
        field: text.slice(fieldSpan.start, fieldSpan.end),
      });
    }

    if (/^LateralViewContext\d*$/u.test(contextName)) {
      const viewName = invokeSingle(node.viewName, node);
      const tableAlias = invokeSingle(node.tableAlias, node);
      const expressions = invokeMany(node.expression, node);
      const functionSpan = viewName ? nodeSpan(viewName, text.length) : undefined;
      const argumentSpan = expressions[0] ? nodeSpan(expressions[0], text.length) : undefined;
      if (functionSpan && argumentSpan) {
        lateralViews.push({
          ...span,
          functionName: text.slice(functionSpan.start, functionSpan.end),
          functionStart: functionSpan.start,
          functionEnd: functionSpan.end,
          argumentStart: argumentSpan.start,
          argumentEnd: argumentSpan.end,
          tableAlias: tableAlias ? sliceNode(text, tableAlias) : '',
          outputAliases: (node._colName ?? []).map((alias) => sliceNode(text, alias)),
        });
      }
    }

    if (/^PartitionFieldContext\d*$/u.test(contextName) && invokeSingle(node.columnType, node)) {
      const definition = splitColumnDefinition(text.slice(span.start, span.end));
      if (definition) {
        partitionColumns.push({ ...definition, ...span });
      }
    }
  });

  collectRecoveredFunctionReferences(text, parser.getAllTokens(masked), references);

  const functionReferences = references.filter((reference) => reference.kind === 'function');
  return {
    references: deduplicateReferences(references.filter((reference) => (
      reference.text.length > 0
        && !(reference.kind === 'column' && functionReferences.some((functionReference) => (
          reference.start === functionReference.start && reference.end <= functionReference.end
        )))
    ))),
    fieldAccesses: deduplicateBySpan(fieldAccesses),
    lateralViews: deduplicateBySpan(lateralViews),
    partitionColumns: deduplicateBySpan(partitionColumns),
  };
}

function collectRecoveredFunctionReferences(
  text: string,
  allTokens: readonly Token[],
  references: SemanticReference[],
): void {
  const tokens = allTokens.filter((token) => token.channel === 0 && token.start >= 0 && token.stop >= token.start);
  const functions = references.filter((reference) => reference.kind === 'function');
  for (let functionIndex = 0; functionIndex < functions.length; functionIndex += 1) {
    const functionReference = functions[functionIndex]!;
    const nameIndex = tokens.findIndex((token) => token.start === functionReference.start);
    const openIndex = tokens.findIndex((token, index) => index > nameIndex && token.start >= functionReference.end);
    if (nameIndex < 0 || openIndex < 0 || tokens[openIndex]?.text !== '('
      || text.slice(functionReference.end, tokens[openIndex]!.start).trim().length > 0) continue;
    const closeIndex = matchingTokenIndex(tokens, openIndex, '(', ')');
    if (closeIndex < 0) continue;
    for (let index = openIndex + 1; index < closeIndex; index += 1) {
      const token = tokens[index]!;
      if (!isLexicalIdentifier(token) || tokens[index - 1]?.text === '.') continue;
      const parts = [token];
      let endIndex = index;
      while (tokens[endIndex + 1]?.text === '.' && tokens[endIndex + 2]
        && isLexicalIdentifier(tokens[endIndex + 2]!)) {
        parts.push(tokens[endIndex + 2]!);
        endIndex += 2;
      }
      const endToken = tokens[endIndex]!;
      const kind = tokens[endIndex + 1]?.text === '(' ? 'function' : 'column';
      const reference: SemanticReference = {
        kind,
        text: text.slice(token.start, endToken.stop + 1),
        start: token.start,
        end: endToken.stop + 1,
      };
      references.push(reference);
      if (kind === 'function' && !functions.some((candidate) => (
        candidate.start === reference.start && candidate.end === reference.end
      ))) {
        functions.push(reference);
      }
      index = endIndex;
    }
  }
}

function matchingTokenIndex(
  tokens: readonly Token[],
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.text === open) depth += 1;
    if (tokens[index]?.text === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isLexicalIdentifier(token: Token): boolean {
  const vocabulary = (token.tokenSource as { vocabulary?: {
    getSymbolicName(tokenType: number): string | null;
  } } | null)?.vocabulary;
  const symbolic = vocabulary?.getSymbolicName(token.type)?.toUpperCase() ?? '';
  if (symbolic.startsWith('KW_')) {
    return symbolic === 'KW_STRUCT' || symbolic === 'KW_ARRAY' || symbolic === 'KW_MAP';
  }
  return symbolic.includes('IDENTIFIER') || symbolic === 'ID'
    || /^(?:`[^`]+`|"[^"]+"|[\p{L}_$][\p{L}\p{N}_$]*)$/u.test(token.text ?? '');
}

function visitTree(node: ParseTreeNode, visitor: (node: ParseTreeNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) {
    visitTree(child, visitor);
  }
}

function nodeSpan(node: ParseTreeNode, textLength: number): { start: number; end: number } | undefined {
  const start = node.start?.start;
  const stop = node.stop?.stop;
  if (start === undefined || stop === undefined || start < 0 || stop < start) return undefined;
  return { start: Math.min(start, textLength), end: Math.min(stop + 1, textLength) };
}

function sliceNode(text: string, node: ParseTreeNode): string {
  const span = nodeSpan(node, text.length);
  return span ? text.slice(span.start, span.end) : '';
}

function invokeSingle(
  method: ParseTreeNode['columnType'] | ParseTreeNode['tableAlias'] | ParseTreeNode['viewName'],
  receiver: ParseTreeNode,
): ParseTreeNode | undefined {
  if (!method) return undefined;
  const result = method.call(receiver);
  return result && !Array.isArray(result) ? result : undefined;
}

function invokeMany(method: ParseTreeNode['expression'], receiver: ParseTreeNode): ParseTreeNode[] {
  if (!method) return [];
  const result = method.call(receiver);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

function splitColumnDefinition(value: string): { name: string; type: string } | undefined {
  const trimmed = value.trim();
  let quote = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (quote) {
      if ((quote === '[' && character === ']') || (quote !== '[' && character === quote)) quote = '';
      continue;
    }
    if (character === '`' || character === '"' || character === '[') {
      quote = character;
    } else if (/\s/u.test(character)) {
      const name = trimmed.slice(0, index).trim();
      const type = trimmed.slice(index).trim();
      return name && type ? { name, type } : undefined;
    }
  }
  return undefined;
}

function flattenEntities(entities: readonly EntityContext[]): EntityContext[] {
  const result: EntityContext[] = [];
  const seen = new Set<EntityContext>();
  const visit = (entity: EntityContext): void => {
    if (seen.has(entity)) return;
    seen.add(entity);
    result.push(entity);
    for (const related of entity.relatedEntities ?? []) visit(related);
    if ('columns' in entity) {
      for (const column of entity.columns ?? []) visit(column);
    }
  };
  entities.forEach(visit);
  return result;
}

function deduplicateReferences(references: readonly SemanticReference[]): SemanticReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.start}:${reference.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nextNonWhitespace(text: string, offset: number): string | undefined {
  for (let index = offset; index < text.length; index += 1) {
    if (!/\s/u.test(text[index] ?? '')) return text[index];
  }
  return undefined;
}

function deduplicateBySpan<T extends { start: number; end: number }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.start}:${value.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
