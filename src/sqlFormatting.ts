import type { SqlFormatConfiguration } from './config';
import { findPlaceholderRanges, maskPlaceholders, type PlaceholderRange } from './patterns';
import { analyzeSql, lexSql, type SqlDialect, type SqlLexToken } from './sql';
import {
  isSqlAstNode,
  parseSqlAstForFormatting,
  type SqlAstNode,
  type SqlAstValue,
} from './sqlAst';

export interface EditorFormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
  eol: string;
  initialIndentColumns?: number;
}

export interface FormattedSqlLine {
  text: string;
  semanticBreakAfter: boolean;
}

interface LayoutLine extends FormattedSqlLine {
  tokenStart: number;
  tokenEnd: number;
}

export interface FormattedSql {
  text: string;
  lines: readonly FormattedSqlLine[];
}

export class SqlFormattingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlFormattingError';
  }
}

interface FormattingToken extends SqlLexToken {
  raw: string;
  upper: string;
  protected: boolean;
  kind: TokenKind;
  compactTypePunctuation: boolean;
  localListComma: boolean;
  expressionDepth: number;
  sourceLine: number;
}

type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'dataType' | 'word' | 'operator' | 'punctuation' | 'opaque';

interface ParenthesisPair {
  open: number;
  close: number;
  kind: ParenthesisKind;
  structural: boolean;
  multiline: boolean;
  listBroken: boolean;
}

type ParenthesisKind = 'local' | 'query' | 'structuralList';

interface ParenthesisContext {
  pair: ParenthesisPair;
  indentBefore: number;
  clauseListBefore: boolean;
  clauseListBrokenBefore: boolean;
  clauseListIndentBefore: number;
}

interface CasePair {
  open: number;
  close: number;
  branchCount: number;
  relativeExpressionDepth: number;
  hasLineComment: boolean;
}

interface CaseContext {
  pair: CasePair;
  indentBefore: number;
  expanded: boolean;
}

interface LogicalGroup {
  kind: 'AND' | 'OR' | 'XOR';
  start: number;
  end: number;
  leafCount: number;
  operatorIndices: readonly number[];
  children: readonly LogicalGroup[];
}

const DATA_TYPES = new Set([
  'ARRAY', 'BIGINT', 'BINARY', 'BOOLEAN', 'BYTE', 'CHAR', 'DATE', 'DATETIME', 'DECIMAL', 'DOUBLE',
  'FLOAT', 'INT', 'INTEGER', 'INTERVAL', 'JSON', 'MAP', 'NUMERIC', 'REAL', 'ROW', 'SMALLINT',
  'STRING', 'STRUCT', 'TEXT', 'TIME', 'TIMESTAMP', 'TINYINT', 'VARCHAR',
]);

const COMPLEX_TYPE_CONSTRUCTORS = new Set(['ARRAY', 'MAP', 'STRUCT']);

const KEYWORDS = new Set([
  'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CLUSTER', 'CREATE', 'CROSS', 'DELETE',
  'DESC', 'DISTINCT', 'BUCKETS', 'CLUSTERED', 'COMMENT', 'DISTRIBUTE', 'DROP', 'ELSE', 'END', 'EXCEPT',
  'EXISTS', 'FROM',
  'FULL', 'GROUP', 'HAVING', 'IN',
  'INNER', 'INSERT', 'INTERSECT', 'INTO', 'JOIN', 'LATERAL', 'LEFT', 'LIMIT', 'MERGE', 'NOT', 'NULL',
  'OFFSET', 'ON', 'OPTIONS', 'OR', 'ORDER', 'OUTER', 'OVER', 'OVERWRITE', 'PARTITION', 'PARTITIONED',
  'QUALIFY', 'RETURNING', 'RIGHT', 'SELECT', 'SET', 'SORT', 'SORTED', 'TABLE', 'THEN', 'UNION',
  'UPDATE', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WINDOW', 'WITH', 'XOR', 'LOCATION',
]);

const OPERATOR_TEXT = /^(?:<>|!=|==|<=>|<=|>=|=>|:=|[-+*/%=<>|&^~])$/u;
const WORD_TEXT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

export function formatSql(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
): FormattedSql {
  if (text.trim().length === 0) {
    return { text: '', lines: [{ text: '', semanticBreakAfter: false }] };
  }

  const parsed = parseSqlAstForFormatting(text, dialect, placeholders);
  if (!parsed || parsed.statements.length === 0) {
    const issue = analyzeSql(text, dialect, placeholders).issues[0];
    const detail = issue
      ? ` at line ${lineNumberAt(text, issue.start)}: ${issue.message}`
      : '.';
    throw new SqlFormattingError(`The ${dialect} SQL parser could not build an AST${detail}`);
  }

  const placeholderRanges = findPlaceholderRanges(text, placeholders);
  const tokens = createFormattingTokens(text, dialect, placeholders, placeholderRanges);
  if (tokens.length === 0) {
    throw new SqlFormattingError('The SQL tokenizer returned no tokens.');
  }
  annotateExpressionDepth(tokens, parsed.statements);
  annotateLateralAliasCommas(tokens, parsed.statements);
  const pairs = pairParentheses(tokens, configuration, editor);
  const cases = pairCases(tokens);
  const ddlClauseStarts = identifyDdlClauseStarts(tokens, pairs);
  const logicalBreaks = planLogicalBreaks(tokens, parsed.statements, pairs, configuration, editor);
  expandParenthesesContainingLogicalBreaks(pairs, logicalBreaks);
  const buildLines = (arithmeticBreaks: ReadonlySet<number>): LayoutLine[] => new SqlLayoutBuilder(
    configuration,
    editor,
    tokens,
    pairs,
    cases,
    ddlClauseStarts,
    logicalBreaks,
    arithmeticBreaks,
  ).format();
  const arithmeticBreaks = new Set<number>();
  let layoutLines = buildLines(arithmeticBreaks);
  while (formattedLinesExceedWidth(layoutLines, configuration, editor)) {
    const nextBreaks = findArithmeticFallbackBreaks(
      layoutLines,
      tokens,
      arithmeticBreaks,
      configuration,
      editor,
    );
    if (nextBreaks.length === 0) break;
    for (const nextBreak of nextBreaks) arithmeticBreaks.add(nextBreak);
    layoutLines = buildLines(arithmeticBreaks);
  }
  const lines: FormattedSqlLine[] = layoutLines.map(({ text: lineText, semanticBreakAfter }) => ({
    text: lineText,
    semanticBreakAfter,
  }));
  const output = lines.map((line) => line.text).join(editor.eol);
  verifyTokenEquivalence(text, output, dialect, placeholders, configuration);
  if (!parseSqlAstForFormatting(output, dialect, placeholders)) {
    throw new SqlFormattingError('The formatted SQL failed the dialect AST round-trip check.');
  }
  return { text: output, lines };
}

function createFormattingTokens(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  placeholderRanges: readonly PlaceholderRange[],
): FormattingToken[] {
  const lexed = [...lexSql(text, dialect, placeholders)].sort((left, right) => left.start - right.start);
  const protectedSpans = expandProtectedSpans(placeholderRanges, lexed);
  const candidates = [
    ...lexed
      .filter((token) => !protectedSpans.some((span) => overlaps(token.start, token.end, span.start, span.end)))
      .map((token) => ({ token, opaque: false })),
    ...protectedSpans.map((span) => ({
      token: {
        start: span.start,
        end: span.end,
        text: text.slice(span.start, span.end),
        symbolicName: '',
        channel: 0,
      },
      opaque: true,
    })),
  ].sort((left, right) => left.token.start - right.token.start || left.token.end - right.token.end);
  const tokens: FormattingToken[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    const token = candidate.token;
    if (token.start > cursor) {
      const gap = text.slice(cursor, token.start);
      if (gap.trim().length > 0) {
        tokens.push(makeToken({
          start: cursor,
          end: token.start,
          text: gap,
          symbolicName: '',
          channel: 0,
        }, placeholderRanges, true));
      }
    }
    if (/^\s*$/u.test(token.text)) {
      cursor = Math.max(cursor, token.end);
      continue;
    }
    if (token.end > cursor) {
      tokens.push(makeToken(token, placeholderRanges, candidate.opaque));
      cursor = token.end;
    }
  }
  if (cursor < text.length && text.slice(cursor).trim().length > 0) {
    tokens.push(makeToken({
      start: cursor,
      end: text.length,
      text: text.slice(cursor),
      symbolicName: '',
      channel: 0,
    }, placeholderRanges, true));
  }
  annotateSourceLines(tokens, text);
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index - 1]?.raw === '.' && (tokens[index]?.kind === 'keyword' || tokens[index]?.kind === 'dataType')) {
      tokens[index]!.kind = 'word';
    }
  }
  annotateComplexTypePunctuation(tokens);
  return tokens;
}

function annotateSourceLines(tokens: FormattingToken[], text: string): void {
  let cursor = 0;
  let line = 0;
  for (const token of tokens) {
    line += countLineBreaks(text.slice(cursor, token.start));
    token.sourceLine = line;
    line += countLineBreaks(text.slice(token.start, token.end));
    cursor = token.end;
  }
}

function countLineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/gu)?.length ?? 0;
}

function expandProtectedSpans(
  ranges: readonly PlaceholderRange[],
  tokens: readonly SqlLexToken[],
): PlaceholderRange[] {
  const expanded = ranges.map((range) => {
    let start = range.start;
    let end = range.end;
    for (const token of tokens) {
      if (overlaps(token.start, token.end, range.start, range.end)) {
        start = Math.min(start, token.start);
        end = Math.max(end, token.end);
      }
    }
    return { start, end };
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: PlaceholderRange[] = [];
  for (const range of expanded) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function makeToken(token: SqlLexToken, placeholders: readonly PlaceholderRange[], opaque: boolean): FormattingToken {
  const raw = token.text;
  const upper = raw.toUpperCase();
  const isProtected = placeholders.some((range) => overlaps(token.start, token.end, range.start, range.end));
  return {
    ...token,
    raw,
    upper,
    protected: isProtected,
    kind: opaque ? 'opaque' : classifyToken(token, raw, upper),
    compactTypePunctuation: false,
    localListComma: false,
    expressionDepth: 0,
    sourceLine: 0,
  };
}

function annotateComplexTypePunctuation(tokens: FormattingToken[]): void {
  const stack: Array<{ punctuation: number[] }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    if (
      token.raw === '<'
      && previous?.kind === 'dataType'
      && COMPLEX_TYPE_CONSTRUCTORS.has(previous.upper)
      && !token.protected
      && !previous.protected
    ) {
      stack.push({ punctuation: [index] });
      continue;
    }
    const context = stack.at(-1);
    if (!context || token.protected) continue;
    if (token.raw === ':') {
      context.punctuation.push(index);
    } else if (token.raw === '>') {
      context.punctuation.push(index);
      stack.pop();
      for (const punctuation of context.punctuation) {
        tokens[punctuation]!.compactTypePunctuation = true;
      }
    }
  }
}

function classifyToken(token: SqlLexToken, raw: string, upper: string): TokenKind {
  const name = token.symbolicName.toUpperCase();
  if (raw.startsWith('--') || raw.startsWith('/*')) return 'comment';
  if (DATA_TYPES.has(upper) || name.includes('DATA_TYPE')) return 'dataType';
  if (/(?:STRING|CHAR|TEXT|BINARY)_?(?:LITERAL|VALUE)?$/u.test(name) || /^['"`]/u.test(raw)) return 'string';
  if (/^(?:\d|\.\d)/u.test(raw) || name.includes('NUMBER') || name.includes('INTEGER')) return 'number';
  if (KEYWORDS.has(upper)) return DATA_TYPES.has(upper) ? 'dataType' : 'keyword';
  if (OPERATOR_TEXT.test(raw) || name.includes('OPERATOR')) return 'operator';
  if (WORD_TEXT.test(raw)) return 'word';
  return 'punctuation';
}

function annotateExpressionDepth(tokens: FormattingToken[], statements: readonly SqlAstNode[]): void {
  for (const statement of statements) {
    annotateNodeDepth(statement, 0, tokens);
  }
}

function annotateLateralAliasCommas(
  tokens: FormattingToken[],
  statements: readonly SqlAstNode[],
): void {
  const visit = (node: SqlAstNode): void => {
    if (node.role === 'lateral') {
      const alias = node.args.alias;
      const columns = isSqlAstNode(alias) && Array.isArray(alias.args.columns)
        ? alias.args.columns.filter(isSqlAstNode)
        : [];
      for (let index = 1; index < columns.length; index += 1) {
        const left = columns[index - 1]!;
        const right = columns[index]!;
        const comma = tokens.find((token) => (
          token.raw === ',' && token.start >= left.end && token.end <= right.start
        ));
        if (comma) comma.localListComma = true;
      }
    }
    for (const value of Object.values(node.args)) {
      if (isSqlAstNode(value)) {
        visit(value);
      } else if (Array.isArray(value)) {
        for (const child of value) if (isSqlAstNode(child)) visit(child);
      }
    }
  };
  for (const statement of statements) visit(statement);
}

function annotateNodeDepth(node: SqlAstNode, parentDepth: number, tokens: FormattingToken[]): void {
  const depth = parentDepth + (countsAsExpression(node, tokens) ? 1 : 0);
  for (const token of tokens) {
    if (token.start >= node.start && token.end <= node.end) {
      token.expressionDepth = Math.max(token.expressionDepth, depth);
    }
  }
  for (const value of Object.values(node.args)) {
    annotateValueDepth(value, depth, tokens);
  }
}

function annotateValueDepth(value: SqlAstValue, depth: number, tokens: FormattingToken[]): void {
  if (isSqlAstNode(value)) {
    annotateNodeDepth(value, depth, tokens);
  } else if (Array.isArray(value)) {
    for (const child of value) annotateValueDepth(child, depth, tokens);
  }
}

function countsAsExpression(node: SqlAstNode, tokens: readonly FormattingToken[]): boolean {
  if (isLogicalNode(node) || arithmeticNodeParts(node, tokens) || isGroupingExpression(node, tokens)) return false;
  return node.role === 'function' || node.role === 'unnest' || node.role === 'subquery'
    || node.role === 'expression';
}

function pairParentheses(
  tokens: readonly FormattingToken[],
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
): Map<number, ParenthesisPair> {
  const result = new Map<number, ParenthesisPair>();
  const stack: number[] = [];
  const rawPairs: Array<{ open: number; close: number }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.protected) continue;
    if (tokens[index]?.raw === '(') stack.push(index);
    if (tokens[index]?.raw === ')') {
      const open = stack.pop();
      if (open === undefined) throw new SqlFormattingError('Unbalanced closing parenthesis.');
      rawPairs.push({ open, close: index });
    }
  }
  if (stack.length > 0) throw new SqlFormattingError('Unbalanced opening parenthesis.');

  const structuralKinds = classifyStructuralParentheses(tokens, rawPairs);
  for (const raw of rawPairs) {
    const kind: ParenthesisKind = structuralKinds.get(raw.open) ?? 'local';
    const structural = kind !== 'local';
    const pairTokens = tokens.slice(raw.open, raw.close + 1);
    const innerTokens = tokens.slice(raw.open + 1, raw.close);
    const inlineWidth = estimateInlineWidth(pairTokens, editor.tabSize);
    const innerWidth = estimateInlineWidth(innerTokens, editor.tabSize);
    const maxDepth = Math.max(...pairTokens.map((token) => token.expressionDepth), 0);
    const minDepth = Math.min(...pairTokens.map((token) => token.expressionDepth), 0);
    const exceedsDepth = maxDepth - minDepth + 1 > configuration.maxInlineExpressionDepth;
    const structuralDepth = rawPairs.filter((candidate) => (
      candidate.open < raw.open && candidate.close > raw.close && structuralKinds.has(candidate.open)
    )).length;
    const initialIndent = editor.initialIndentColumns ?? 0;
    const multiline = structural
      || inlineWidth + initialIndent + structuralDepth * editor.tabSize
        > configuration.maxLineWidth
      || exceedsDepth;
    const listBroken = kind === 'query'
      ? false
      : kind === 'structuralList'
        ? configuration.layoutMode === 'expanded'
          || countTopLevelItems(tokens, raw.open + 1, raw.close) > configuration.maxInlineItems
          || innerTokens.some((token) => token.kind === 'comment' && token.raw.trimStart().startsWith('--'))
          || innerWidth + initialIndent + (structuralDepth + 1) * editor.tabSize
            > configuration.maxLineWidth
          || exceedsDepth
        : multiline;
    const pair: ParenthesisPair = { ...raw, kind, structural, multiline, listBroken };
    result.set(raw.open, pair);
    result.set(raw.close, pair);
  }
  return result;
}

function classifyStructuralParentheses(
  tokens: readonly FormattingToken[],
  pairs: ReadonlyArray<{ open: number; close: number }>,
): Map<number, Exclude<ParenthesisKind, 'local'>> {
  const structural = new Map<number, Exclude<ParenthesisKind, 'local'>>();
  for (const pair of pairs) {
    const next = tokens[pair.open + 1]?.upper;
    if (next === 'SELECT' || next === 'WITH' || next === 'VALUES') {
      structural.set(pair.open, 'query');
    }
  }

  for (let start = 0; start < tokens.length;) {
    const semicolon = tokens.findIndex((token, index) => index >= start && token.raw === ';');
    const end = semicolon >= 0 ? semicolon : tokens.length;
    const statement = tokens.slice(start, end);
    const words = statement.map((token) => token.upper);
    const create = words.indexOf('CREATE');
    const table = create >= 0 ? words.indexOf('TABLE', create + 1) : -1;
    if (table >= 0) {
      const suffix = statement.findIndex((_, index) => index > table && isCreateTableSuffixStart(statement, index));
      const queryStart = statement.findIndex((_, index) => (
        index > table && isCreateTableQueryStart(statement, index)
      ));
      const boundaryCandidates = [suffix, queryStart].filter((value) => value >= 0);
      const boundary = boundaryCandidates.length > 0 ? Math.min(...boundaryCandidates) : statement.length;
      const open = statement.findIndex((token, index) => index > table && index < boundary && token.raw === '(');
      if (open >= 0 && structural.get(start + open) !== 'query') {
        structural.set(start + open, 'structuralList');
      }
    }
    const insert = words.indexOf('INSERT');
    const into = insert >= 0 ? words.indexOf('INTO', insert + 1) : -1;
    if (into >= 0) {
      const boundaryCandidates = ['PARTITION', 'SELECT', 'VALUES'].map((word) => words.indexOf(word, into + 1)).filter((value) => value >= 0);
      const boundary = boundaryCandidates.length > 0 ? Math.min(...boundaryCandidates) : statement.length;
      const open = statement.findIndex((token, index) => index > into && index < boundary && token.raw === '(');
      if (open >= 0 && structural.get(start + open) !== 'query') {
        structural.set(start + open, 'structuralList');
      }
    }
    start = end + 1;
  }
  return structural;
}

function identifyDdlClauseStarts(
  tokens: readonly FormattingToken[],
  pairs: ReadonlyMap<number, ParenthesisPair>,
): Set<number> {
  const starts = new Set<number>();
  for (let statementStart = 0; statementStart < tokens.length;) {
    const semicolon = tokens.findIndex((token, index) => index >= statementStart && token.raw === ';');
    const statementEnd = semicolon >= 0 ? semicolon : tokens.length;
    const create = tokens.findIndex((token, index) => (
      index >= statementStart && index < statementEnd && token.upper === 'CREATE'
    ));
    const table = create >= 0
      ? tokens.findIndex((token, index) => index > create && index < statementEnd && token.upper === 'TABLE')
      : -1;
    if (table >= 0) {
      let depth = 0;
      for (let index = table + 1; index < statementEnd; index += 1) {
        const token = tokens[index]!;
        if (token.raw === '(') {
          const pair = pairs.get(index);
          if (pair?.structural) {
            index = pair.close;
            continue;
          }
          depth += 1;
          continue;
        }
        if (token.raw === ')') {
          depth = Math.max(0, depth - 1);
          continue;
        }
        if (depth > 0) continue;
        if (isCreateTableQueryStart(tokens, index)) break;
        if (isCreateTableSuffixStart(tokens, index)) starts.add(index);
      }
    }
    statementStart = statementEnd + 1;
  }
  return starts;
}

function isCreateTableQueryStart(tokens: readonly FormattingToken[], index: number): boolean {
  return tokens[index]?.upper === 'AS'
    && ['SELECT', 'WITH'].includes(tokens[index + 1]?.upper ?? '');
}

function isCreateTableSuffixStart(tokens: readonly FormattingToken[], index: number): boolean {
  const upper = tokens[index]?.upper;
  if (['USING', 'OPTIONS', 'LOCATION', 'COMMENT'].includes(upper ?? '')) return true;
  if (upper === 'PARTITIONED' && tokens[index + 1]?.upper === 'BY') return true;
  if (upper === 'CLUSTERED' && tokens[index + 1]?.upper === 'BY') return true;
  if (upper === 'SORTED' && tokens[index + 1]?.upper === 'BY') return true;
  if (upper !== 'INTO') return false;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const candidate = tokens[cursor]!;
    if (candidate.raw === ';' || candidate.raw === ')') return false;
    if (candidate.upper === 'BUCKETS') return true;
    if (isCreateTableSuffixStart(tokens, cursor)) return false;
  }
  return false;
}

function planLogicalBreaks(
  tokens: readonly FormattingToken[],
  statements: readonly SqlAstNode[],
  pairs: ReadonlyMap<number, ParenthesisPair>,
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
): ReadonlySet<number> {
  const breaks = new Set<number>();
  const roots: LogicalGroup[] = [];
  for (const statement of statements) collectLogicalGroups(statement, false, tokens, roots);
  const covered = new Set<number>();
  for (const root of roots) {
    const available = logicalAvailableWidth(root, tokens, pairs, configuration, editor);
    const highLevel = isHighLevelPredicateGroup(root, tokens);
    planLogicalGroup(
      root,
      configuration.layoutMode === 'expanded',
      highLevel,
      available,
      tokens,
      configuration,
      editor.tabSize,
      breaks,
    );
    if (highLevel) collectLogicalOperatorIndices(root, covered);
  }
  planFallbackLogicalBreaks(tokens, pairs, covered, configuration, editor, breaks);
  return breaks;
}

function expandParenthesesContainingLogicalBreaks(
  pairs: ReadonlyMap<number, ParenthesisPair>,
  logicalBreaks: ReadonlySet<number>,
): void {
  for (const [index, pair] of pairs) {
    if (index !== pair.open || pair.kind !== 'local') continue;
    if ([...logicalBreaks].some((logicalBreak) => logicalBreak > pair.open && logicalBreak < pair.close)) {
      pair.multiline = true;
      pair.listBroken = true;
    }
  }
}

function collectLogicalOperatorIndices(group: LogicalGroup, result: Set<number>): void {
  for (const operator of group.operatorIndices) result.add(operator);
  for (const child of group.children) collectLogicalOperatorIndices(child, result);
}

function planFallbackLogicalBreaks(
  tokens: readonly FormattingToken[],
  pairs: ReadonlyMap<number, ParenthesisPair>,
  covered: ReadonlySet<number>,
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
  breaks: Set<number>,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if ([...pairs.entries()].some(([open, pair]) => (
      open === pair.open && !pair.structural && pair.open < index && pair.close > index
    ))) continue;
    const phrase = clausePhraseAt(tokens, index);
    if (!phrase || (phrase.kind !== 'where' && phrase.kind !== 'on')) continue;
    const start = index + phrase.length;
    const end = findClauseEndInTokens(tokens, start);
    if ([...covered].some((operator) => operator >= start && operator < end)) {
      index = Math.max(index, end - 1);
      continue;
    }
    const brokenParenthesisDepth = [...pairs.entries()].filter(([open, pair]) => (
      open === pair.open && pair.multiline && pair.open < start && pair.close > start
    )).length;
    const clauseIndent = phrase.kind === 'on' ? 2 : 1;
    const available = Math.max(
      configuration.maxLineWidth
        - (editor.initialIndentColumns ?? 0)
        - (brokenParenthesisDepth + clauseIndent) * editor.tabSize,
      1,
    );
    planFallbackLogicalRange(
      tokens,
      start,
      end,
      configuration.layoutMode === 'expanded',
      configuration.maxInlineItems,
      available,
      editor.tabSize,
      breaks,
    );
    index = Math.max(index, end - 1);
  }
}

function findClauseEndInTokens(tokens: readonly FormattingToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.raw === '(') {
      depth += 1;
      continue;
    }
    if (token.raw === ')') {
      if (depth === 0) return index;
      depth -= 1;
      continue;
    }
    if (depth === 0 && (token.raw === ';' || clausePhraseAt(tokens, index))) return index;
  }
  return tokens.length;
}

function planFallbackLogicalRange(
  tokens: readonly FormattingToken[],
  start: number,
  end: number,
  force: boolean,
  maxInlineItems: number,
  available: number,
  tabSize: number,
  breaks: Set<number>,
): void {
  const candidates: Array<{ index: number; precedence: number }> = [];
  let depth = 0;
  let betweenPending = false;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index]!;
    if (token.raw === '(') {
      depth += 1;
      continue;
    }
    if (token.raw === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (token.upper === 'BETWEEN') {
      betweenPending = true;
      continue;
    }
    if (!isLogical(token)) continue;
    if (token.upper === 'AND' && betweenPending) {
      betweenPending = false;
      continue;
    }
    betweenPending = false;
    candidates.push({ index, precedence: logicalPrecedence(token.upper) });
  }
  if (candidates.length === 0) return;
  if (
    !force
    && countLogicalLeavesInRange(tokens, start, end) <= maxInlineItems
    && estimateInlineWidth(tokens.slice(start, end), tabSize) <= available
  ) return;
  const precedence = Math.min(...candidates.map((candidate) => candidate.precedence));
  const operators = candidates.filter((candidate) => candidate.precedence === precedence);
  for (const operator of operators) breaks.add(operator.index);
  let segmentStart = start;
  for (const operator of operators) {
    planFallbackLogicalRange(
      tokens,
      segmentStart,
      operator.index,
      force,
      maxInlineItems,
      available,
      tabSize,
      breaks,
    );
    segmentStart = operator.index + 1;
  }
  planFallbackLogicalRange(tokens, segmentStart, end, force, maxInlineItems, available, tabSize, breaks);
}

function countLogicalLeavesInRange(
  tokens: readonly FormattingToken[],
  start: number,
  end: number,
): number {
  let operators = 0;
  let betweenPending = false;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index]!;
    if (token.upper === 'BETWEEN') {
      betweenPending = true;
      continue;
    }
    if (!isLogical(token)) continue;
    if (token.upper === 'AND' && betweenPending) {
      betweenPending = false;
      continue;
    }
    betweenPending = false;
    operators += 1;
  }
  return operators + 1;
}

function logicalPrecedence(operator: string): number {
  if (operator === 'OR') return 1;
  if (operator === 'XOR') return 2;
  return 3;
}

function logicalAvailableWidth(
  group: LogicalGroup,
  tokens: readonly FormattingToken[],
  pairs: ReadonlyMap<number, ParenthesisPair>,
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
): number {
  const start = tokens.findIndex((token) => token.start >= group.start && token.end <= group.end);
  return expressionAvailableWidth(start, tokens, pairs, configuration, editor);
}

function expressionAvailableWidth(
  start: number,
  tokens: readonly FormattingToken[],
  pairs: ReadonlyMap<number, ParenthesisPair>,
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
): number {
  const brokenParenthesisDepth = [...pairs.entries()].filter(([index, pair]) => (
    index === pair.open && pair.multiline && pair.open < start && pair.close > start
  )).length;
  let extraIndent = 1;
  for (let index = start - 1; index >= 0; index -= 1) {
    const phrase = clausePhraseAt(tokens, index);
    if (phrase) {
      if (phrase.kind === 'on') extraIndent = 2;
      break;
    }
    if (tokens[index]?.raw === ';' || tokens[index]?.raw === '(') break;
  }
  return Math.max(
    configuration.maxLineWidth
      - (editor.initialIndentColumns ?? 0)
      - (brokenParenthesisDepth + extraIndent) * editor.tabSize,
    1,
  );
}

function collectLogicalGroups(
  node: SqlAstNode,
  parentLogical: boolean,
  tokens: readonly FormattingToken[],
  roots: LogicalGroup[],
): void {
  const group = makeLogicalGroup(node, tokens);
  const logical = group !== undefined;
  if (group && !parentLogical) roots.push(group);
  for (const child of sqlAstNodeChildren(node)) {
    collectLogicalGroups(child, logical, tokens, roots);
  }
}

function makeLogicalGroup(node: SqlAstNode, tokens: readonly FormattingToken[]): LogicalGroup | undefined {
  const logicalNode = logicalNodeWithinPredicateWrappers(node, tokens);
  if (!logicalNode) return undefined;
  const kind = logicalNode.kind.toUpperCase() as LogicalGroup['kind'];
  const operands = flattenLogicalOperands(logicalNode, kind);
  const operatorIndices: number[] = [];
  for (let index = 0; index < operands.length - 1; index += 1) {
    const left = operands[index]!;
    const right = operands[index + 1]!;
    const operatorIndex = tokens.findIndex((token) => (
      token.start >= left.end && token.end <= right.start && token.upper === kind
    ));
    if (operatorIndex >= 0) operatorIndices.push(operatorIndex);
  }
  if (operatorIndices.length !== operands.length - 1) return undefined;
  const children = operands.flatMap((operand) => {
    const child = makeLogicalGroup(operand, tokens);
    return child ? [child] : [];
  });
  return {
    kind,
    start: node.start,
    end: node.end,
    leafCount: operands.reduce((count, operand) => count + countLogicalLeaves(operand, tokens), 0),
    operatorIndices,
    children,
  };
}

function countLogicalLeaves(node: SqlAstNode, tokens: readonly FormattingToken[]): number {
  const logicalNode = logicalNodeWithinPredicateWrappers(node, tokens);
  if (!logicalNode) return 1;
  const left = logicalNode.args.this;
  const right = logicalNode.args.expression;
  if (!isSqlAstNode(left) || !isSqlAstNode(right)) return 1;
  return countLogicalLeaves(left, tokens) + countLogicalLeaves(right, tokens);
}

/**
 * Parentheses and unary predicate wrappers such as NOT are layout boundaries, not logical-leaf boundaries.
 * Resolve only wrappers whose visible tokens are already accepted as predicate wrappers; semantic containers
 * such as functions, CASE, casts, aliases, and subqueries remain opaque to the high-level logical item limit.
 */
function logicalNodeWithinPredicateWrappers(
  node: SqlAstNode,
  tokens: readonly FormattingToken[],
): SqlAstNode | undefined {
  let current = node;
  const seen = new Set<SqlAstNode>();
  while (!isLogicalNode(current)) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const children = sqlAstNodeChildren(current);
    if (children.length !== 1) return undefined;
    const child = children[0]!;
    if (!isTransparentPredicateWrapper(current, child, tokens)) return undefined;
    current = child;
  }
  return current;
}

function sqlAstNodeChildren(node: SqlAstNode): SqlAstNode[] {
  return Object.values(node.args).flatMap(sqlAstNodesInValue);
}

function sqlAstNodesInValue(value: SqlAstValue): SqlAstNode[] {
  if (isSqlAstNode(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(sqlAstNodesInValue);
  return [];
}

function isTransparentPredicateWrapper(
  wrapper: SqlAstNode,
  child: SqlAstNode,
  tokens: readonly FormattingToken[],
): boolean {
  if (wrapper.start > child.start || wrapper.end < child.end) return false;
  for (const token of tokens) {
    if (token.end <= wrapper.start || token.start >= wrapper.end) continue;
    if (token.start < wrapper.start || token.end > wrapper.end) return false;
    if (token.start >= child.start && token.end <= child.end) continue;
    if (token.end <= child.start) {
      if (!isPredicateWrapperPrefix(token)) return false;
      continue;
    }
    if (token.start >= child.end) {
      if (!isPredicateWrapperSuffix(token)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function flattenLogicalOperands(node: SqlAstNode, kind: LogicalGroup['kind']): SqlAstNode[] {
  if (node.kind.toUpperCase() !== kind) return [node];
  const left = node.args.this;
  const right = node.args.expression;
  if (!isSqlAstNode(left) || !isSqlAstNode(right)) return [node];
  return [
    ...flattenLogicalOperands(left, kind),
    ...flattenLogicalOperands(right, kind),
  ];
}

function planLogicalGroup(
  group: LogicalGroup,
  force: boolean,
  applyItemLimit: boolean,
  available: number,
  tokens: readonly FormattingToken[],
  configuration: SqlFormatConfiguration,
  tabSize: number,
  breaks: Set<number>,
): void {
  const groupTokens = tokens.filter((token) => token.start >= group.start && token.end <= group.end);
  const broken = force
    || (applyItemLimit && group.leafCount > configuration.maxInlineItems)
    || estimateInlineWidth(groupTokens, tabSize) > available;
  if (!broken) return;
  for (const operator of group.operatorIndices) breaks.add(operator);
  for (const child of group.children) {
    planLogicalGroup(child, force, applyItemLimit, available, tokens, configuration, tabSize, breaks);
  }
}

function isHighLevelPredicateGroup(
  group: LogicalGroup,
  tokens: readonly FormattingToken[],
): boolean {
  const groupStart = tokens.findIndex((token) => token.start >= group.start && token.end <= group.end);
  let groupEnd = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (token.start >= group.start && token.end <= group.end) {
      groupEnd = index;
      break;
    }
  }
  if (groupStart < 0 || groupEnd < groupStart) return false;

  for (let index = groupStart - 1; index >= 0; index -= 1) {
    const phrase = clausePhraseAt(tokens, index);
    if (!phrase) {
      if (tokens[index]?.raw === ';') return false;
      continue;
    }
    if (phrase.kind !== 'where' && phrase.kind !== 'on') return false;
    const contentStart = index + phrase.length;
    const clauseEnd = findClauseEndInTokens(tokens, contentStart);
    if (groupEnd >= clauseEnd) return false;
    const prefix = tokens.slice(contentStart, groupStart);
    const suffix = tokens.slice(groupEnd + 1, clauseEnd);
    return prefix.every(isPredicateWrapperPrefix) && suffix.every(isPredicateWrapperSuffix);
  }
  return false;
}

function isPredicateWrapperPrefix(token: FormattingToken): boolean {
  return token.raw === '(' || token.upper === 'NOT' || token.kind === 'comment';
}

function isPredicateWrapperSuffix(token: FormattingToken): boolean {
  return token.raw === ')' || token.kind === 'comment';
}

function isLogicalNode(node: SqlAstNode): boolean {
  return ['AND', 'OR', 'XOR'].includes(node.kind.toUpperCase());
}

interface ArithmeticNodeParts {
  readonly left: SqlAstNode;
  readonly right: SqlAstNode;
  readonly operatorIndex: number;
  readonly precedence: number;
}

function arithmeticNodeParts(
  node: SqlAstNode,
  tokens: readonly FormattingToken[],
): ArithmeticNodeParts | undefined {
  const left = node.args.this;
  const right = node.args.expression;
  if (!isSqlAstNode(left) || !isSqlAstNode(right)) return undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.end <= left.end) continue;
    if (token.start >= right.start) break;
    if (token.start < left.end || token.end > right.start) continue;
    const precedence = arithmeticPrecedence(token);
    if (precedence > 0) return { left, right, operatorIndex: index, precedence };
  }
  return undefined;
}

function arithmeticPrecedence(token: FormattingToken): number {
  if (token.protected) return 0;
  if (token.raw === '+' || token.raw === '-') return 1;
  if (token.raw === '*' || token.raw === '/' || token.raw === '%' || token.upper === 'DIV' || token.upper === 'MOD') {
    return 2;
  }
  return 0;
}

function isGroupingExpression(node: SqlAstNode, tokens: readonly FormattingToken[]): boolean {
  const children = sqlAstNodeChildren(node);
  if (children.length !== 1) return false;
  const child = children[0]!;
  let opening = false;
  let closing = false;
  for (const token of tokens) {
    if (token.end <= node.start || token.start >= node.end) continue;
    if (token.start >= child.start && token.end <= child.end) continue;
    if (token.raw === '(' && token.end <= child.start) {
      opening = true;
      continue;
    }
    if (token.raw === ')' && token.start >= child.end) {
      closing = true;
      continue;
    }
    return false;
  }
  return opening && closing;
}

interface ArithmeticFallbackCandidate {
  readonly index: number;
  readonly precedence: number;
  readonly depth: number;
}

function findArithmeticFallbackBreaks(
  lines: readonly LayoutLine[],
  tokens: readonly FormattingToken[],
  existingBreaks: ReadonlySet<number>,
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
): number[] {
  const initialIndent = editor.initialIndentColumns ?? 0;
  for (const line of lines) {
    if (line.tokenStart < 0 || line.tokenEnd < line.tokenStart) continue;
    if (initialIndent + visualWidth(line.text, editor.tabSize) <= configuration.maxLineWidth) continue;

    const candidates = arithmeticFallbackCandidates(
      tokens,
      line.tokenStart,
      line.tokenEnd,
      existingBreaks,
    );
    if (candidates.length === 0) continue;

    // Prefer operators at the shallowest syntactic level, then the lowest
    // arithmetic precedence. This mirrors the AST shape without depending on
    // parser source-span precision at function/wrapper boundaries.
    const depth = Math.min(...candidates.map((candidate) => candidate.depth));
    const shallow = candidates.filter((candidate) => candidate.depth === depth);
    const precedence = Math.min(...shallow.map((candidate) => candidate.precedence));
    const preferred = shallow.filter((candidate) => candidate.precedence === precedence);

    // Match logical-expression planning: once a precedence level has to break,
    // break every operator at that same level in the current layout segment.
    // A later layout pass may then discover that the next-higher precedence
    // level also needs expansion (for example, '/' after all '+'/'-' breaks).
    return preferred.map((candidate) => candidate.index);
  }
  return [];
}

function arithmeticFallbackCandidates(
  tokens: readonly FormattingToken[],
  start: number,
  end: number,
  existingBreaks: ReadonlySet<number>,
): ArithmeticFallbackCandidate[] {
  const candidates: ArithmeticFallbackCandidate[] = [];
  let depth = 0;
  for (let index = 0; index <= end && index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.raw === ')' || token.raw === ']' || token.raw === '}') {
      depth = Math.max(0, depth - 1);
    }
    if (index >= start && !existingBreaks.has(index)) {
      const precedence = arithmeticPrecedence(token);
      if (precedence > 0 && isBinaryArithmeticOperator(tokens, index)) {
        candidates.push({ index, precedence, depth });
      }
    }
    if (token.raw === '(' || token.raw === '[' || token.raw === '{') {
      depth += 1;
    }
  }
  return candidates;
}

function isBinaryArithmeticOperator(
  tokens: readonly FormattingToken[],
  index: number,
): boolean {
  const token = tokens[index];
  if (!token || arithmeticPrecedence(token) === 0) return false;

  let previousIndex = index - 1;
  while (previousIndex >= 0 && tokens[previousIndex]?.kind === 'comment') previousIndex -= 1;
  let nextIndex = index + 1;
  while (nextIndex < tokens.length && tokens[nextIndex]?.kind === 'comment') nextIndex += 1;
  const previous = tokens[previousIndex];
  const next = tokens[nextIndex];
  if (!previous || !next) return false;
  if (previous.kind === 'operator' || isLogical(previous)) return false;
  if (['(', '[', '{', ',', ';', '.'].includes(previous.raw)) return false;
  if ([
    'AS', 'BY', 'ELSE', 'HAVING', 'ON', 'QUALIFY', 'RETURNING', 'SELECT',
    'SET', 'THEN', 'VALUES', 'WHEN', 'WHERE',
  ].includes(previous.upper)) return false;
  return true;
}

function pairCases(tokens: readonly FormattingToken[]): Map<number, CasePair> {
  const result = new Map<number, CasePair>();
  const stack: number[] = [];
  const rawPairs: Array<{ open: number; close: number }> = [];
  let previousUpper: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.protected) {
      previousUpper = undefined;
      continue;
    }
    if (token.kind === 'comment') continue;
    if (token.upper === 'CASE' && previousUpper !== 'END') {
      stack.push(index);
    } else if (token.upper === 'END' && stack.length > 0) {
      rawPairs.push({ open: stack.pop()!, close: index });
    }
    previousUpper = token.upper;
  }
  if (stack.length > 0) throw new SqlFormattingError('Unclosed CASE expression.');

  for (const raw of rawPairs) {
    const caseTokens = tokens.slice(raw.open, raw.close + 1);
    const baseDepth = tokens[raw.open]?.expressionDepth ?? 0;
    const maxDepth = Math.max(...caseTokens.map((token) => token.expressionDepth), baseDepth);
    const pair: CasePair = {
      ...raw,
      branchCount: countCaseBranches(tokens, raw),
      relativeExpressionDepth: Math.max(0, maxDepth - baseDepth),
      hasLineComment: caseTokens.some((token) => (
        token.kind === 'comment' && token.raw.trimStart().startsWith('--')
      )),
    };
    result.set(raw.open, pair);
    result.set(raw.close, pair);
  }
  return result;
}

function countCaseBranches(
  tokens: readonly FormattingToken[],
  pair: { open: number; close: number },
): number {
  let nestedCases = 0;
  let branches = 0;
  for (let index = pair.open + 1; index < pair.close; index += 1) {
    const token = tokens[index]!;
    if (token.protected || token.kind === 'comment') continue;
    if (token.upper === 'CASE') {
      nestedCases += 1;
    } else if (token.upper === 'END' && nestedCases > 0) {
      nestedCases -= 1;
    } else if (nestedCases === 0 && (token.upper === 'WHEN' || token.upper === 'ELSE')) {
      branches += 1;
    }
  }
  return branches;
}

class SqlLayoutBuilder {
  private readonly lines: LayoutLine[] = [];
  private current = '';
  private currentTokenStart = -1;
  private currentTokenEnd = -1;
  private activeTokenIndex = -1;
  private indent = 0;
  private contexts: ParenthesisContext[] = [];
  private caseContexts: CaseContext[] = [];
  private clauseList = false;
  private clauseListBroken = false;
  private clauseListIndent = 0;
  private pendingListBreakIndent: number | undefined;
  private pendingStatementGap = false;

  constructor(
    private readonly configuration: SqlFormatConfiguration,
    private readonly editor: EditorFormattingOptions,
    private readonly tokens: readonly FormattingToken[],
    private readonly pairs: ReadonlyMap<number, ParenthesisPair>,
    private readonly cases: ReadonlyMap<number, CasePair>,
    private readonly ddlClauseStarts: ReadonlySet<number>,
    private readonly logicalBreaks: ReadonlySet<number>,
    private readonly arithmeticBreaks: ReadonlySet<number>,
  ) {}

  format(): LayoutLine[] {
    for (let index = 0; index < this.tokens.length; index += 1) {
      const token = this.tokens[index]!;
      this.activeTokenIndex = index;
      const previous = this.tokens[index - 1];
      if (this.pendingListBreakIndent !== undefined
        && (token.kind !== 'comment' || token.sourceLine !== previous?.sourceLine)) {
        this.flushPendingListBreak(false);
      }
      if (this.pendingStatementGap
        && (token.kind !== 'comment' || token.sourceLine !== previous?.sourceLine)) {
        this.flushPendingStatementGap();
      }
      const ddlClauseStart = this.ddlClauseStarts.has(index);
      if (ddlClauseStart) {
        if (this.current.trim().length > 0) this.finishLine(false);
        this.indent = this.baseIndent();
        this.clauseList = false;
        this.clauseListBroken = false;
        this.clauseListIndent = this.indent;
      }
      const phrase = ddlClauseStart ? undefined : this.readClausePhrase(index);
      if (phrase) {
        this.formatClause(phrase.kind, this.tokens.slice(index, index + phrase.length), index);
        index += phrase.length - 1;
        continue;
      }
      const casePair = this.cases.get(index);
      if (token.upper === 'CASE' && !token.protected && casePair?.open === index) {
        this.openCase(index, token, casePair);
      } else if (token.upper === 'WHEN' && !token.protected && this.caseContexts.length > 0) {
        this.caseBranch(token);
      } else if (token.upper === 'ELSE' && !token.protected && this.caseContexts.length > 0) {
        this.caseBranch(token);
      } else if (token.upper === 'END' && !token.protected && casePair?.close === index) {
        this.closeCase(index, token, casePair);
      } else if (token.raw === '(' && !token.protected) {
        this.openParenthesis(index);
      } else if (token.raw === ')' && !token.protected) {
        this.closeParenthesis(index);
      } else if (token.raw === ',' && !token.protected) {
        this.comma(index, this.shouldBreakList(index));
      } else if (token.raw === ';' && !token.protected) {
        this.semicolon(index);
      } else if (isLogical(token) && this.logicalBreaks.has(index)) {
        this.logical(token);
      } else if (this.arithmeticBreaks.has(index)) {
        this.arithmetic(token);
      } else if (token.kind === 'comment') {
        this.comment(token, index);
      } else {
        this.appendToken(token, index);
      }
    }
    if (this.pendingListBreakIndent !== undefined) this.flushPendingListBreak(false);
    if (this.pendingStatementGap) this.flushPendingStatementGap();
    this.finishLine(false);
    while (this.lines.length > 1 && this.lines.at(-1)?.text === '') this.lines.pop();
    return this.lines.length > 0
      ? this.lines
      : [{
          text: '',
          semanticBreakAfter: false,
          tokenStart: -1,
          tokenEnd: -1,
        }];
  }

  private readClausePhrase(index: number): { kind: string; length: number } | undefined {
    if (this.contexts.some((context) => !context.pair.structural)) return undefined;
    return clausePhraseAt(this.tokens, index);
  }

  private formatClause(kind: string, phrase: readonly FormattingToken[], phraseIndex: number): void {
    const base = this.baseIndent();
    if (kind === 'insert') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = false;
      this.clauseListBroken = false;
      this.clauseListIndent = base;
      return;
    }
    if (kind === 'with') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = true;
      this.clauseListBroken = this.configuration.layoutMode === 'expanded'
        || this.shouldBreakClause(phraseIndex, phrase.length, true);
      this.clauseListIndent = base;
      return;
    }
    if (isStatementListClause(kind)) {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = true;
      this.clauseListBroken = this.configuration.layoutMode === 'expanded'
        || this.shouldBreakClause(phraseIndex, phrase.length, true);
      this.clauseListIndent = base + 1;
      if (this.clauseListBroken && !this.firstItemStartsWithQueryWrapper(phraseIndex + phrase.length)) {
        this.finishLine(false, this.clauseListIndent);
      }
      return;
    }
    if (kind === 'join' || kind === 'set' || kind === 'simple') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = false;
      this.clauseListBroken = false;
      this.clauseListIndent = base;
      return;
    }
    if (kind === 'where' || kind === 'on') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = kind === 'on' ? base + 1 : base;
      this.appendPhrase(phrase);
      const broken = this.configuration.layoutMode === 'expanded'
        || this.shouldBreakClause(phraseIndex, phrase.length);
      if (broken) this.finishLine(false, this.indent + 1);
      this.clauseList = false;
      this.clauseListBroken = false;
      this.clauseListIndent = this.indent;
      return;
    }
    if (kind === 'using') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base + 1;
      this.appendPhrase(phrase);
      this.clauseList = false;
      this.clauseListBroken = false;
      this.clauseListIndent = this.indent;
      return;
    }
  }

  private shouldBreakClause(
    phraseIndex: number,
    phraseLength: number,
    countItems = false,
  ): boolean {
    const end = this.findClauseEnd(phraseIndex + phraseLength);
    const nestedQueries = this.nestedQueryPairs(phraseIndex + phraseLength, end);
    const isInsideQuery = (index: number): boolean => nestedQueries.some((pair) => (
      index > pair.open && index < pair.close
    ));
    const isInQueryRange = (index: number): boolean => nestedQueries.some((pair) => (
      index >= pair.open && index <= pair.close
    ));
    const clauseTokens = this.tokens.slice(phraseIndex, end).filter((_, offset) => (
      !isInsideQuery(phraseIndex + offset)
    ));
    if (clauseTokens.some((token) => token.kind === 'comment' && token.raw.trimStart().startsWith('--'))) {
      return true;
    }
    const depthTokens = this.tokens.slice(phraseIndex, end).filter((_, offset) => (
      !isInQueryRange(phraseIndex + offset)
    ));
    const maxDepth = Math.max(...depthTokens.map((token) => token.expressionDepth), 0);
    const minDepth = Math.min(...depthTokens.map((token) => token.expressionDepth), 0);
    if (maxDepth - minDepth + 1 > this.configuration.maxInlineExpressionDepth) return true;
    if (countItems) {
      const itemCount = countTopLevelItems(this.tokens, phraseIndex + phraseLength, end);
      if (itemCount > this.configuration.maxInlineItems) return true;
      if (itemCount > 1 && nestedQueries.length > 0) return true;
    }
    for (let index = phraseIndex + phraseLength; index < end; index += 1) {
      if (isInsideQuery(index)) continue;
      const pair = this.cases.get(index);
      if (
        pair?.open === index
        && pair.branchCount > this.configuration.maxInlineItems
      ) return true;
    }
    for (let index = phraseIndex + phraseLength; index < end; index += 1) {
      if (isInsideQuery(index)) continue;
      if (this.logicalBreaks.has(index)) return true;
    }
    if (clauseTokens.some((token) => {
      if (token.raw !== '(') return false;
      const pair = this.pairs.get(this.tokens.indexOf(token));
      return pair?.kind !== 'query' && pair?.multiline === true;
    })) {
      return true;
    }
    const occupied = (this.editor.initialIndentColumns ?? 0) + this.indent * this.editor.tabSize;
    return occupied + estimateDisplayedWidth(clauseTokens, this.tokens, this.configuration, this.editor.tabSize)
      > this.configuration.maxLineWidth;
  }

  private nestedQueryPairs(start: number, end: number): ParenthesisPair[] {
    return [...this.pairs.entries()].flatMap(([index, pair]) => (
      index === pair.open && pair.kind === 'query' && pair.open >= start && pair.close < end
        ? [pair]
        : []
    ));
  }

  private firstItemStartsWithQueryWrapper(start: number): boolean {
    for (let index = start; index < this.tokens.length; index += 1) {
      const token = this.tokens[index]!;
      if (token.kind === 'comment') continue;
      return token.raw === '(' && this.pairs.get(index)?.kind === 'query';
    }
    return false;
  }

  private findClauseEnd(start: number): number {
    let depth = 0;
    for (let index = start; index < this.tokens.length; index += 1) {
      const token = this.tokens[index]!;
      if (token.raw === '(') {
        depth += 1;
        continue;
      }
      if (token.raw === ')') {
        if (depth === 0) return index;
        depth -= 1;
        continue;
      }
      if (depth > 0) continue;
      if (token.raw === ';' || this.ddlClauseStarts.has(index) || clausePhraseAt(this.tokens, index)) {
        return index;
      }
    }
    return this.tokens.length;
  }

  private appendPhrase(tokens: readonly FormattingToken[]): void {
    for (const token of tokens) this.appendRaw(displayToken(token, this.tokens, this.configuration), true);
  }

  private openCase(index: number, token: FormattingToken, pair: CasePair): void {
    const context: CaseContext = {
      pair,
      indentBefore: this.indent,
      expanded: this.shouldExpandCase(pair),
    };
    this.appendRaw(
      displayToken(token, this.tokens, this.configuration),
      needsSpaceBefore(this.tokens, index, this.current),
    );
    this.caseContexts.push(context);
  }

  private caseBranch(token: FormattingToken): void {
    const context = this.caseContexts.at(-1);
    if (!context?.expanded) {
      this.appendRaw(displayToken(token, this.tokens, this.configuration), true);
      return;
    }
    if (this.current.trim().length > 0) this.finishLine(false);
    this.indent = context.indentBefore + 1;
    this.appendRaw(displayToken(token, this.tokens, this.configuration), false);
  }

  private closeCase(index: number, token: FormattingToken, pair: CasePair): void {
    const context = this.caseContexts.pop();
    if (!context || context.pair !== pair) throw new SqlFormattingError('Mismatched CASE expression terminator.');
    if (!context.expanded) {
      this.appendToken(token, index);
      return;
    }
    if (this.current.trim().length > 0) this.finishLine(false);
    this.indent = context.indentBefore;
    this.appendRaw(displayToken(token, this.tokens, this.configuration), false);
  }

  private shouldExpandCase(pair: CasePair): boolean {
    if (this.configuration.layoutMode === 'expanded' || pair.hasLineComment) return true;
    if (pair.branchCount > this.configuration.maxInlineItems) return true;
    if (pair.relativeExpressionDepth > this.configuration.maxInlineExpressionDepth) return true;

    let candidate = this.current;
    for (let index = pair.open; index <= pair.close; index += 1) {
      const token = this.tokens[index]!;
      const spacer = needsSpaceBefore(this.tokens, index, candidate) && candidate.length > 0 ? ' ' : '';
      candidate += `${spacer}${displayToken(token, this.tokens, this.configuration)}`;
    }
    const available = this.configuration.maxLineWidth
      - (this.editor.initialIndentColumns ?? 0)
      - this.indent * this.editor.tabSize;
    return visualWidth(candidate, this.editor.tabSize) > Math.max(available, 1);
  }

  private openParenthesis(index: number): void {
    const pair = this.pairs.get(index);
    if (!pair) throw new SqlFormattingError('Missing opening-parenthesis pair.');
    const indentBefore = this.indent;
    const clauseListBefore = this.clauseList;
    const clauseListBrokenBefore = this.clauseListBroken;
    const clauseListIndentBefore = this.clauseListIndent;
    const needsSpace = pair.structural || !isFunctionOpen(this.tokens, index);
    if (pair.structural && this.configuration.structuralParenthesisPosition === 'newLine') {
      this.finishLine(false, indentBefore);
      this.appendRaw('(', false);
    } else {
      this.appendRaw('(', needsSpace);
    }
    this.contexts.push({
      pair,
      indentBefore,
      clauseListBefore,
      clauseListBrokenBefore,
      clauseListIndentBefore,
    });
    this.clauseList = false;
    this.clauseListBroken = false;
    this.clauseListIndent = indentBefore + 1;
    if (pair.multiline) {
      this.finishLine(false, indentBefore + 1);
    }
  }

  private closeParenthesis(index: number): void {
    const context = this.contexts.pop();
    if (!context || context.pair.close !== index) throw new SqlFormattingError('Mismatched closing parenthesis.');
    if (context.pair.multiline) {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = context.indentBefore;
      this.appendRaw(')', false);
    } else {
      this.appendRaw(')', false);
    }
    this.clauseList = context.clauseListBefore;
    this.clauseListBroken = context.clauseListBrokenBefore;
    this.clauseListIndent = context.clauseListIndentBefore;
  }

  private comma(index: number, shouldBreak: boolean): void {
    if (!shouldBreak) {
      this.appendRaw(',', false);
      return;
    }
    const nextIndent = this.clauseList && this.clauseListBroken
      ? this.clauseListIndent
      : this.indent;
    if (this.configuration.commaPosition === 'trailing') {
      this.appendRaw(',', false);
      const token = this.tokens[index]!;
      const next = this.tokens[index + 1];
      if (next?.kind === 'comment' && next.sourceLine === token.sourceLine) {
        this.pendingListBreakIndent = nextIndent;
      } else {
        this.finishLine(false, nextIndent);
      }
    } else {
      this.finishLine(false, nextIndent);
      this.appendRaw(',', false);
      this.appendRaw(' ', false);
    }
  }

  private semicolon(index: number): void {
    if (this.configuration.semicolonPosition === 'newLine' && this.current.trim().length > 0) {
      this.finishLine(false, this.baseIndent());
    }
    this.appendRaw(';', false);
    if (this.hasFollowingStatement(index)) {
      const token = this.tokens[index]!;
      const next = this.tokens[index + 1];
      if (next?.kind === 'comment' && next.sourceLine === token.sourceLine) {
        this.pendingStatementGap = true;
      } else {
        this.insertStatementGap();
      }
    }
    this.clauseList = false;
    this.clauseListBroken = false;
    this.clauseListIndent = 0;
  }

  private logical(token: FormattingToken): void {
    const display = displayToken(token, this.tokens, this.configuration);
    if (this.configuration.logicalOperatorPosition === 'before') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.appendRaw(display, false);
    } else {
      this.appendRaw(display, true);
      this.finishLine(false);
    }
  }

  private arithmetic(token: FormattingToken): void {
    if (this.current.trim().length > 0) this.finishLine(false);
    this.appendRaw(displayToken(token, this.tokens, this.configuration), false);
  }

  private comment(token: FormattingToken, index: number): void {
    const previous = this.tokens[index - 1];
    if (this.current.trim().length > 0 && previous && token.sourceLine !== previous.sourceLine) {
      this.finishLine(false);
    }
    this.appendRaw(token.raw, this.current.trim().length > 0);
    if (token.raw.trimStart().startsWith('--')) {
      const nextIndent = this.pendingListBreakIndent;
      this.pendingListBreakIndent = undefined;
      this.finishLine(true, nextIndent ?? this.indent);
    }
  }

  private appendToken(token: FormattingToken, index: number): void {
    const display = displayToken(token, this.tokens, this.configuration);
    const space = needsSpaceBefore(this.tokens, index, this.current);
    this.appendRaw(display, space);
  }

  private appendRaw(value: string, spaceBefore: boolean): void {
    if (value.length > 0 && this.activeTokenIndex >= 0) {
      if (this.currentTokenStart < 0) this.currentTokenStart = this.activeTokenIndex;
      this.currentTokenEnd = Math.max(this.currentTokenEnd, this.activeTokenIndex);
    }
    const spacer = spaceBefore && this.current.length > 0 && !this.current.endsWith(' ') ? ' ' : '';
    this.current = `${this.current}${spacer}${value}`;
  }

  private flushPendingListBreak(semanticBreakAfter: boolean): void {
    const nextIndent = this.pendingListBreakIndent;
    if (nextIndent === undefined) return;
    this.pendingListBreakIndent = undefined;
    this.finishLine(semanticBreakAfter, nextIndent);
  }

  private hasFollowingStatement(index: number): boolean {
    for (let cursor = index + 1; cursor < this.tokens.length; cursor += 1) {
      if (this.tokens[cursor]?.kind !== 'comment') return true;
    }
    return false;
  }

  private flushPendingStatementGap(): void {
    if (!this.pendingStatementGap) return;
    this.pendingStatementGap = false;
    this.insertStatementGap();
  }

  private insertStatementGap(): void {
    this.finishLine(false, 0);
    for (let index = 0; index < this.configuration.blankLinesBetweenStatements; index += 1) {
      this.lines.push({
        text: '',
        semanticBreakAfter: false,
        tokenStart: -1,
        tokenEnd: -1,
      });
    }
  }

  private shouldBreakList(index: number): boolean {
    if (this.tokens[index]?.localListComma) return false;
    const context = this.contexts.at(-1);
    return context?.pair.listBroken === true
      || (this.clauseList && this.clauseListBroken);
  }

  private baseIndent(): number {
    const enclosing = [...this.contexts].reverse().find((context) => context.pair.multiline);
    return enclosing ? enclosing.indentBefore + 1 : 0;
  }

  private finishLine(semanticBreakAfter: boolean, nextIndent = this.indent): void {
    if (this.current.length > 0) {
      this.lines.push({
        text: `${indentUnit(this.editor).repeat(this.indent)}${this.current.trimEnd()}`,
        semanticBreakAfter,
        tokenStart: this.currentTokenStart,
        tokenEnd: this.currentTokenEnd,
      });
      this.current = '';
      this.currentTokenStart = -1;
      this.currentTokenEnd = -1;
    }
    this.indent = nextIndent;
  }
}

function displayToken(
  token: FormattingToken,
  tokens: readonly FormattingToken[],
  configuration: SqlFormatConfiguration,
): string {
  if (token.protected || token.kind === 'string' || token.kind === 'comment' || token.kind === 'opaque') return token.raw;
  if (token.kind === 'keyword') return applyCase(token.raw, configuration.keywordCase);
  if (token.kind === 'dataType') return applyCase(token.raw, configuration.dataTypeCase);
  const index = tokens.indexOf(token);
  if (token.kind === 'word' && isFunctionName(tokens, index)) return applyCase(token.raw, configuration.functionCase);
  return token.raw;
}

function applyCase(value: string, mode: 'preserve' | 'upper' | 'lower'): string {
  if (mode === 'upper') return value.toUpperCase();
  if (mode === 'lower') return value.toLowerCase();
  return value;
}

function isFunctionName(tokens: readonly FormattingToken[], index: number): boolean {
  if (index < 0 || tokens[index]?.kind !== 'word' || tokens[index + 1]?.raw !== '(') return false;
  return !['AS', 'EXISTS', 'FROM', 'INTO', 'JOIN', 'TABLE', 'UPDATE'].includes(tokens[index - 1]?.upper ?? '');
}

function isFunctionOpen(tokens: readonly FormattingToken[], index: number): boolean {
  const previous = tokens[index - 1];
  return isFunctionName(tokens, index - 1)
    || previous?.kind === 'dataType'
    || (previous?.protected === true && previous.end === tokens[index]?.start);
}

function needsSpaceBefore(tokens: readonly FormattingToken[], index: number, current: string): boolean {
  if (current.length === 0) return false;
  const token = tokens[index]!;
  const previous = tokens[index - 1];
  if (!previous) return false;
  if (token.compactTypePunctuation) return false;
  if (previous.compactTypePunctuation && previous.raw === '<') return false;
  if (token.raw === '.' || token.raw === ']' || token.raw === ')' || token.raw === ',' || token.raw === ';') return false;
  if (previous.raw === '.' || previous.raw === '[' || previous.raw === '(') return false;
  if (token.raw === '[') return false;
  return true;
}

function isLogical(token: FormattingToken): boolean {
  return token.upper === 'AND' || token.upper === 'OR' || token.upper === 'XOR';
}

function isStatementListClause(kind: string): boolean {
  return [
    'select', 'from', 'group', 'order', 'list', 'values', 'returning', 'window', 'updateSet',
  ].includes(kind);
}

function countTopLevelItems(
  tokens: readonly FormattingToken[],
  start: number,
  end: number,
): number {
  let depth = 0;
  let commas = 0;
  let hasContent = false;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index]!;
    if (token.kind === 'comment') continue;
    if (token.raw === '(' || token.raw === '[' || token.raw === '{') {
      depth += 1;
      hasContent = true;
      continue;
    }
    if (token.raw === ')' || token.raw === ']' || token.raw === '}') {
      depth = Math.max(0, depth - 1);
      hasContent = true;
      continue;
    }
    if (token.raw === ',' && depth === 0 && !token.localListComma) {
      commas += 1;
      continue;
    }
    hasContent = true;
  }
  return hasContent ? commas + 1 : 0;
}

function clausePhraseAt(
  tokens: readonly FormattingToken[],
  index: number,
): { kind: string; length: number } | undefined {
  const at = (...words: string[]): boolean => words.every((word, offset) => tokens[index + offset]?.upper === word);
  const phrases: Array<[string, string[]]> = [
    ['join', ['LEFT', 'OUTER', 'JOIN']], ['join', ['RIGHT', 'OUTER', 'JOIN']], ['join', ['FULL', 'OUTER', 'JOIN']],
    ['join', ['LEFT', 'JOIN']], ['join', ['RIGHT', 'JOIN']], ['join', ['FULL', 'JOIN']],
    ['join', ['INNER', 'JOIN']], ['join', ['CROSS', 'JOIN']], ['join', ['JOIN']],
    ['group', ['GROUP', 'BY']], ['order', ['ORDER', 'BY']], ['list', ['CLUSTER', 'BY']],
    ['list', ['DISTRIBUTE', 'BY']], ['list', ['SORT', 'BY']],
    ['set', ['UNION', 'ALL']], ['set', ['UNION', 'DISTINCT']], ['set', ['UNION']],
    ['set', ['INTERSECT']], ['set', ['EXCEPT']],
    ['insert', ['INSERT', 'OVERWRITE']], ['insert', ['INSERT', 'INTO']],
    ['with', ['WITH']],
    ['select', ['SELECT']], ['from', ['FROM']], ['where', ['WHERE']], ['where', ['HAVING']],
    ['where', ['QUALIFY']], ['on', ['ON']], ['using', ['USING']], ['simple', ['LIMIT']],
    ['simple', ['OFFSET']], ['values', ['VALUES']], ['returning', ['RETURNING']], ['window', ['WINDOW']],
  ];
  for (const [kind, words] of phrases) {
    if (at(...words)) return { kind, length: words.length };
  }
  if (at('SET') && isUpdateAssignmentSet(tokens, index)) return { kind: 'updateSet', length: 1 };
  return undefined;
}

function isUpdateAssignmentSet(tokens: readonly FormattingToken[], index: number): boolean {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor]!;
    if (token.raw === ')') {
      depth += 1;
      continue;
    }
    if (token.raw === '(') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (token.raw === ';') return false;
    if (token.upper === 'UPDATE') return true;
    if (['SELECT', 'INSERT', 'DELETE', 'CREATE'].includes(token.upper)) return false;
  }
  return false;
}

function estimateInlineWidth(tokens: readonly FormattingToken[], tabSize: number): number {
  let text = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const space = needsSpaceBefore(tokens, index, text);
    text += `${space ? ' ' : ''}${token.raw}`;
  }
  return visualWidth(text, tabSize);
}

function estimateDisplayedWidth(
  range: readonly FormattingToken[],
  allTokens: readonly FormattingToken[],
  configuration: SqlFormatConfiguration,
  tabSize: number,
): number {
  let text = '';
  for (const token of range) {
    const index = allTokens.indexOf(token);
    const space = needsSpaceBefore(allTokens, index, text);
    text += `${space ? ' ' : ''}${displayToken(token, allTokens, configuration)}`;
  }
  return visualWidth(text, tabSize);
}

function visualWidth(text: string, tabSize: number): number {
  let column = 0;
  for (const character of text) {
    if (character === '\t') column += tabSize - (column % tabSize);
    else column += 1;
  }
  return column;
}

function formattedLinesExceedWidth(
  lines: readonly FormattedSqlLine[],
  configuration: SqlFormatConfiguration,
  editor: EditorFormattingOptions,
): boolean {
  const initialIndent = editor.initialIndentColumns ?? 0;
  return lines.some((line) => (
    initialIndent + visualWidth(line.text, editor.tabSize) > configuration.maxLineWidth
  ));
}

function indentUnit(editor: EditorFormattingOptions): string {
  return editor.insertSpaces ? ' '.repeat(editor.tabSize) : '\t';
}

function verifyTokenEquivalence(
  before: string,
  after: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  configuration: SqlFormatConfiguration,
): void {
  const left = equivalenceTokens(before, dialect, placeholders, configuration);
  const right = equivalenceTokens(after, dialect, placeholders, configuration);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    const mismatch = Math.max(0, left.findIndex((value, index) => value !== right[index]));
    throw new SqlFormattingError(
      `The formatted SQL changed its significant token sequence near token ${mismatch + 1}: `
      + `${describeEquivalenceToken(left[mismatch])} -> ${describeEquivalenceToken(right[mismatch])}.`,
    );
  }
}

function equivalenceTokens(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
  configuration: SqlFormatConfiguration,
): string[] {
  const masked = maskPlaceholders(text, placeholders).text;
  const lexed = lexSql(masked, dialect).filter((token) => !/^\s*$/u.test(token.text));
  return lexed.map((token, index) => {
    const raw = masked.slice(token.start, token.end);
    const upper = raw.toUpperCase();
    const kind = classifyToken(token, raw, upper);
    const comparableRaw = kind === 'comment' && raw.trimStart().startsWith('--')
      ? raw.replace(/(?:\r\n|\r|\n)$/u, '')
      : raw;
    if (kind === 'keyword' && configuration.keywordCase !== 'preserve') return `${token.symbolicName}:${upper}`;
    if (kind === 'dataType' && configuration.dataTypeCase !== 'preserve') return `${token.symbolicName}:${upper}`;
    if (kind === 'word' && lexed[index + 1]?.text === '(' && configuration.functionCase !== 'preserve') {
      return `${token.symbolicName}:${upper}`;
    }
    return `${token.symbolicName}:${comparableRaw}`;
  });
}

function describeEquivalenceToken(value: string | undefined): string {
  return value === undefined ? '<end>' : JSON.stringify(value);
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split(/\r\n|\r|\n/u).length;
}
