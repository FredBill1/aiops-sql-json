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
  expressionDepth: number;
}

type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'dataType' | 'word' | 'operator' | 'punctuation' | 'opaque';

interface ParenthesisPair {
  open: number;
  close: number;
  structural: boolean;
  broken: boolean;
}

interface ParenthesisContext {
  pair: ParenthesisPair;
  indentBefore: number;
  clauseListBefore: boolean;
}

const DATA_TYPES = new Set([
  'ARRAY', 'BIGINT', 'BINARY', 'BOOLEAN', 'BYTE', 'CHAR', 'DATE', 'DATETIME', 'DECIMAL', 'DOUBLE',
  'FLOAT', 'INT', 'INTEGER', 'INTERVAL', 'JSON', 'MAP', 'NUMERIC', 'REAL', 'ROW', 'SMALLINT',
  'STRING', 'STRUCT', 'TEXT', 'TIME', 'TIMESTAMP', 'TINYINT', 'VARCHAR',
]);

const KEYWORDS = new Set([
  'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BY', 'CASE', 'CREATE', 'CROSS', 'DELETE', 'DESC', 'DISTINCT',
  'DISTRIBUTE', 'DROP', 'ELSE', 'END', 'EXCEPT', 'EXISTS', 'FROM', 'FULL', 'GROUP', 'HAVING', 'IN',
  'INNER', 'INSERT', 'INTERSECT', 'INTO', 'JOIN', 'LATERAL', 'LEFT', 'LIMIT', 'MERGE', 'NOT', 'NULL',
  'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'OVERWRITE', 'PARTITION', 'QUALIFY', 'RETURNING',
  'RIGHT', 'SELECT', 'SET', 'SORT', 'TABLE', 'THEN', 'UNION', 'UPDATE', 'USING', 'VALUES', 'VIEW',
  'WHEN', 'WHERE', 'WINDOW', 'WITH', 'XOR',
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
  const pairs = pairParentheses(tokens, configuration, editor);
  const builder = new SqlLayoutBuilder(configuration, editor, tokens, pairs);
  const lines = builder.format();
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
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index - 1]?.raw === '.' && (tokens[index]?.kind === 'keyword' || tokens[index]?.kind === 'dataType')) {
      tokens[index]!.kind = 'word';
    }
  }
  return tokens;
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
    expressionDepth: 0,
  };
}

function classifyToken(token: SqlLexToken, raw: string, upper: string): TokenKind {
  const name = token.symbolicName.toUpperCase();
  if (name.includes('COMMENT') || raw.startsWith('--') || raw.startsWith('/*')) return 'comment';
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

function annotateNodeDepth(node: SqlAstNode, parentDepth: number, tokens: FormattingToken[]): void {
  const depth = parentDepth + (countsAsExpression(node) ? 1 : 0);
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

function countsAsExpression(node: SqlAstNode): boolean {
  return node.role === 'function' || node.role === 'unnest' || node.role === 'subquery' || node.role === 'expression';
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

  const structuralOpens = identifyStructuralParentheses(tokens, rawPairs);
  for (const raw of rawPairs) {
    const structural = structuralOpens.has(raw.open);
    const inlineWidth = estimateInlineWidth(tokens.slice(raw.open, raw.close + 1), editor.tabSize);
    const maxDepth = Math.max(...tokens.slice(raw.open, raw.close + 1).map((token) => token.expressionDepth), 0);
    const minDepth = Math.min(...tokens.slice(raw.open, raw.close + 1).map((token) => token.expressionDepth), 0);
    const broken = structural
      || inlineWidth + (editor.initialIndentColumns ?? 0) > configuration.maxLineWidth
      || maxDepth - minDepth + 1 > configuration.maxInlineExpressionDepth;
    const pair = { ...raw, structural, broken };
    result.set(raw.open, pair);
    result.set(raw.close, pair);
  }
  return result;
}

function identifyStructuralParentheses(
  tokens: readonly FormattingToken[],
  pairs: ReadonlyArray<{ open: number; close: number }>,
): Set<number> {
  const structural = new Set<number>();
  for (const pair of pairs) {
    const next = tokens[pair.open + 1]?.upper;
    if (next === 'SELECT' || next === 'WITH') structural.add(pair.open);
  }

  for (let start = 0; start < tokens.length;) {
    const semicolon = tokens.findIndex((token, index) => index >= start && token.raw === ';');
    const end = semicolon >= 0 ? semicolon : tokens.length;
    const statement = tokens.slice(start, end);
    const words = statement.map((token) => token.upper);
    const create = words.indexOf('CREATE');
    const table = create >= 0 ? words.indexOf('TABLE', create + 1) : -1;
    if (table >= 0) {
      const open = statement.findIndex((token, index) => index > table && token.raw === '(');
      if (open >= 0) structural.add(start + open);
    }
    const insert = words.indexOf('INSERT');
    const into = insert >= 0 ? words.indexOf('INTO', insert + 1) : -1;
    if (into >= 0) {
      const boundaryCandidates = ['PARTITION', 'SELECT', 'VALUES'].map((word) => words.indexOf(word, into + 1)).filter((value) => value >= 0);
      const boundary = boundaryCandidates.length > 0 ? Math.min(...boundaryCandidates) : statement.length;
      const open = statement.findIndex((token, index) => index > into && index < boundary && token.raw === '(');
      if (open >= 0) structural.add(start + open);
    }
    start = end + 1;
  }
  return structural;
}

class SqlLayoutBuilder {
  private readonly lines: FormattedSqlLine[] = [];
  private current = '';
  private indent = 0;
  private contexts: ParenthesisContext[] = [];
  private clauseList = false;

  constructor(
    private readonly configuration: SqlFormatConfiguration,
    private readonly editor: EditorFormattingOptions,
    private readonly tokens: readonly FormattingToken[],
    private readonly pairs: ReadonlyMap<number, ParenthesisPair>,
  ) {}

  format(): FormattedSqlLine[] {
    for (let index = 0; index < this.tokens.length; index += 1) {
      const token = this.tokens[index]!;
      const phrase = this.readClausePhrase(index);
      if (phrase) {
        this.formatClause(phrase.kind, this.tokens.slice(index, index + phrase.length));
        index += phrase.length - 1;
        continue;
      }
      if (token.raw === '(' && !token.protected) {
        this.openParenthesis(index, token);
      } else if (token.raw === ')' && !token.protected) {
        this.closeParenthesis(index, token);
      } else if (token.raw === ',' && !token.protected) {
        this.comma(token, this.shouldBreakList());
      } else if (token.raw === ';' && !token.protected) {
        this.semicolon(token, index < this.tokens.length - 1);
      } else if (isLogical(token) && this.shouldBreakLogical(token, index)) {
        this.logical(token);
      } else if (token.kind === 'comment') {
        this.comment(token);
      } else {
        this.appendToken(token, index);
      }
    }
    this.finishLine(false);
    while (this.lines.length > 1 && this.lines.at(-1)?.text === '') this.lines.pop();
    return this.lines.length > 0 ? this.lines : [{ text: '', semanticBreakAfter: false }];
  }

  private readClausePhrase(index: number): { kind: string; length: number } | undefined {
    if (this.contexts.some((context) => !context.pair.structural)) return undefined;
    const at = (...words: string[]): boolean => words.every((word, offset) => this.tokens[index + offset]?.upper === word);
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
      ['simple', ['OFFSET']], ['values', ['VALUES']], ['simple', ['RETURNING']], ['simple', ['WINDOW']],
    ];
    for (const [kind, words] of phrases) {
      if (at(...words)) return { kind, length: words.length };
    }
    return undefined;
  }

  private formatClause(kind: string, phrase: readonly FormattingToken[]): void {
    const base = this.baseIndent();
    if (kind === 'insert') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = false;
      return;
    }
    if (kind === 'with') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = true;
      return;
    }
    if (kind === 'select') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = true;
      if (this.configuration.statementListLayout === 'onePerLine') this.finishLine(false, base + 1);
      return;
    }
    if (kind === 'join' || kind === 'from' || kind === 'set' || kind === 'simple' || kind === 'values') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = false;
      return;
    }
    if (kind === 'where' || kind === 'on') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = kind === 'on' ? base + 1 : base;
      this.appendPhrase(phrase);
      this.finishLine(false, this.indent + 1);
      this.clauseList = false;
      return;
    }
    if (kind === 'using') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base + 1;
      this.appendPhrase(phrase);
      return;
    }
    if (kind === 'group' || kind === 'order' || kind === 'list') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = base;
      this.appendPhrase(phrase);
      this.clauseList = true;
      if (this.configuration.statementListLayout === 'onePerLine') this.finishLine(false, base + 1);
    }
  }

  private appendPhrase(tokens: readonly FormattingToken[]): void {
    for (const token of tokens) this.appendRaw(displayToken(token, this.tokens, this.configuration), true, token);
  }

  private openParenthesis(index: number, token: FormattingToken): void {
    const pair = this.pairs.get(index);
    if (!pair) throw new SqlFormattingError('Missing opening-parenthesis pair.');
    const indentBefore = this.indent;
    const clauseListBefore = this.clauseList;
    const needsSpace = pair.structural || !isFunctionOpen(this.tokens, index);
    if (pair.structural && this.configuration.structuralParenthesisPosition === 'newLine') {
      this.finishLine(false, indentBefore);
      this.appendRaw('(', false, token);
    } else {
      this.appendRaw('(', needsSpace, token);
    }
    this.contexts.push({ pair, indentBefore, clauseListBefore });
    this.clauseList = pair.structural && this.configuration.statementListLayout === 'onePerLine';
    if (pair.broken) {
      this.finishLine(false, indentBefore + 1);
    }
  }

  private closeParenthesis(index: number, token: FormattingToken): void {
    const context = this.contexts.pop();
    if (!context || context.pair.close !== index) throw new SqlFormattingError('Mismatched closing parenthesis.');
    if (context.pair.broken) {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.indent = context.indentBefore;
      this.appendRaw(')', false, token);
    } else {
      this.appendRaw(')', false, token);
    }
    this.clauseList = context.clauseListBefore;
  }

  private comma(token: FormattingToken, shouldBreak: boolean): void {
    if (!shouldBreak) {
      this.appendRaw(',', false, token);
      return;
    }
    if (this.configuration.commaPosition === 'trailing') {
      this.appendRaw(',', false, token);
      this.finishLine(false);
    } else {
      this.finishLine(false);
      this.appendRaw(',', false, token);
      this.appendRaw(' ', false, token);
    }
  }

  private semicolon(token: FormattingToken, hasMore: boolean): void {
    if (this.configuration.semicolonPosition === 'newLine' && this.current.trim().length > 0) {
      this.finishLine(false, this.baseIndent());
    }
    this.appendRaw(';', false, token);
    if (hasMore) {
      this.finishLine(false, 0);
      for (let index = 0; index < this.configuration.blankLinesBetweenStatements; index += 1) {
        this.lines.push({ text: '', semanticBreakAfter: false });
      }
    }
    this.clauseList = false;
  }

  private logical(token: FormattingToken): void {
    const display = displayToken(token, this.tokens, this.configuration);
    if (this.configuration.logicalOperatorPosition === 'before') {
      if (this.current.trim().length > 0) this.finishLine(false);
      this.appendRaw(display, false, token);
    } else {
      this.appendRaw(display, true, token);
      this.finishLine(false);
    }
  }

  private comment(token: FormattingToken): void {
    this.appendRaw(token.raw, this.current.trim().length > 0, token);
    if (token.raw.trimStart().startsWith('--')) this.finishLine(true);
  }

  private appendToken(token: FormattingToken, index: number): void {
    const display = displayToken(token, this.tokens, this.configuration);
    const space = needsSpaceBefore(this.tokens, index, this.current);
    const exceedsDepth = token.expressionDepth > this.configuration.maxInlineExpressionDepth
      && (token.kind === 'operator' || isLogical(token));
    if (exceedsDepth && this.current.trim().length > 0) this.finishLine(false);
    this.appendRaw(display, space, token);
  }

  private appendRaw(value: string, spaceBefore: boolean, token: FormattingToken): void {
    const spacer = spaceBefore && this.current.length > 0 && !this.current.endsWith(' ') ? ' ' : '';
    const candidate = `${this.current}${spacer}${value}`;
    const available = this.configuration.maxLineWidth
      - (this.editor.initialIndentColumns ?? 0)
      - this.indent * this.editor.tabSize;
    if (this.current.trim().length > 0 && visualWidth(candidate, this.editor.tabSize) > Math.max(available, 1)
      && canBreakBefore(token)) {
      this.finishLine(false);
      this.current = value;
    } else {
      this.current = candidate;
    }
  }

  private shouldBreakList(): boolean {
    const context = this.contexts.at(-1);
    return context?.pair.broken === true
      || (this.clauseList && this.configuration.statementListLayout === 'onePerLine');
  }

  private shouldBreakLogical(token: FormattingToken, tokenIndex: number): boolean {
    const available = this.configuration.maxLineWidth
      - (this.editor.initialIndentColumns ?? 0)
      - this.indent * this.editor.tabSize;
    if (token.expressionDepth > this.configuration.maxInlineExpressionDepth) return true;
    let continuation = ` ${displayToken(token, this.tokens, this.configuration)}`;
    for (let index = tokenIndex + 1; index < this.tokens.length; index += 1) {
      const candidate = this.tokens[index]!;
      if (candidate.raw === ';' || candidate.raw === ',' || candidate.raw === ')') break;
      if (['GROUP', 'ORDER', 'HAVING', 'QUALIFY', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT'].includes(candidate.upper)) break;
      continuation += `${needsSpaceBefore(this.tokens, index, continuation) ? ' ' : ''}${candidate.raw}`;
      if (visualWidth(this.current + continuation, this.editor.tabSize) > available) return true;
    }
    return visualWidth(this.current + continuation, this.editor.tabSize) > available;
  }

  private baseIndent(): number {
    return this.contexts.filter((context) => context.pair.broken).length;
  }

  private finishLine(semanticBreakAfter: boolean, nextIndent = this.indent): void {
    if (this.current.length > 0) {
      this.lines.push({
        text: `${indentUnit(this.editor).repeat(this.indent)}${this.current.trimEnd()}`,
        semanticBreakAfter,
      });
      this.current = '';
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
  if (token.raw === '.' || token.raw === ']' || token.raw === ')' || token.raw === ',' || token.raw === ';') return false;
  if (previous.raw === '.' || previous.raw === '[' || previous.raw === '(') return false;
  if (token.raw === '[') return false;
  return true;
}

function isLogical(token: FormattingToken): boolean {
  return token.upper === 'AND' || token.upper === 'OR' || token.upper === 'XOR';
}

function canBreakBefore(token: FormattingToken): boolean {
  return token.raw !== ')' && token.raw !== ']' && token.raw !== ',' && token.raw !== ';' && token.raw !== '.';
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

function visualWidth(text: string, tabSize: number): number {
  let column = 0;
  for (const character of text) {
    if (character === '\t') column += tabSize - (column % tabSize);
    else column += 1;
  }
  return column;
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
      + `${left[mismatch] ?? '<end>'} -> ${right[mismatch] ?? '<end>'}.`,
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
    if (kind === 'keyword' && configuration.keywordCase !== 'preserve') return `${token.symbolicName}:${upper}`;
    if (kind === 'dataType' && configuration.dataTypeCase !== 'preserve') return `${token.symbolicName}:${upper}`;
    if (kind === 'word' && lexed[index + 1]?.text === '(' && configuration.functionCase !== 'preserve') {
      return `${token.symbolicName}:${upper}`;
    }
    return `${token.symbolicName}:${raw}`;
  });
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split(/\r\n|\r|\n/u).length;
}
