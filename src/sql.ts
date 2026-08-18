import {
  FlinkSQL,
  GenericSQL,
  HiveSQL,
  ImpalaSQL,
  MySQL,
  PostgreSQL,
  SparkSQL,
  TrinoSQL,
} from 'dt-sql-parser';
import type { CaretPosition, EntityContext, ParseError, Suggestions } from 'dt-sql-parser';
import type { ParserRuleContext, Token } from 'antlr4ng';

import { maskPlaceholders } from './patterns';

export const SQL_DIALECTS = [
  'spark',
  'hive',
  'flink',
  'mysql',
  'postgresql',
  'trino',
  'impala',
  'generic',
] as const;

export type SqlDialect = (typeof SQL_DIALECTS)[number];
export type SqlTokenType = 'comment' | 'string' | 'keyword' | 'number' | 'operator' | 'function' | 'variable';

export interface SqlIssue {
  start: number;
  end: number;
  message: string;
}

export interface SqlToken {
  start: number;
  end: number;
  type: SqlTokenType;
}

export interface SqlAnalysis {
  issues: SqlIssue[];
  tokens: SqlToken[];
}

interface StructuralSqlIssue extends SqlIssue {
  contextStart?: number;
  contextEnd?: number;
}

interface SqlStatementSlice {
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface ParserLike {
  parse(input: string): ParserRuleContext;
  validate(input: string): ParseError[];
  getAllTokens(input: string): Token[];
  splitSQLByStatement(input: string): SqlStatementSlice[] | null;
  getSuggestionAtCaretPosition(input: string, caretPosition: CaretPosition): Suggestions | null;
  getAllEntities(input: string, caretPosition?: CaretPosition): EntityContext[] | null;
  createLexer(input: string): { vocabulary: VocabularyLike };
}

export interface VocabularyLike {
  readonly maxTokenType: number;
  getLiteralName(tokenType: number): string | null;
  getSymbolicName(tokenType: number): string | null;
}

export interface SqlLexToken {
  start: number;
  end: number;
  text: string;
  symbolicName: string;
  channel: number;
}

const parserCache = new Map<SqlDialect, ParserLike>();

export function isSqlDialect(value: unknown): value is SqlDialect {
  return typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value);
}

export function analyzeSql(text: string, dialect: SqlDialect, placeholders: readonly RegExp[]): SqlAnalysis {
  if (text.trim().length === 0) {
    return { issues: [], tokens: [] };
  }

  const parser = getSqlParser(dialect);
  const masked = maskPlaceholders(text, placeholders).text;
  let errors: ParseError[] = [];
  let antlrTokens: Token[] = [];
  let statements: SqlStatementSlice[] = [];
  try {
    errors = parser.validate(masked);
    antlrTokens = parser.getAllTokens(masked);
    if (errors.length === 0) {
      statements = parser.splitSQLByStatement(masked) ?? [];
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      issues: [{ start: 0, end: Math.max(text.length, 1), message: `SQL parser failed: ${message}` }],
      tokens: [],
    };
  }

  // Keep the dialect parser authoritative for syntax. The normalized AST frontend is deliberately
  // permissive for formatting and semantic recovery, so building an AST is not proof of valid SQL.
  const parserIssues = errors.map((error) => parseErrorToIssue(text, error));
  const structuralIssues = findStructuralIssues(antlrTokens, statements)
    .filter((issue) => !parserIssues.some((parserIssue) => parserIssueCoversStructuralIssue(parserIssue, issue)))
    .map(stripStructuralContext);
  const issues = deduplicateIssues([...parserIssues, ...structuralIssues]);
  const tokens = antlrTokens.flatMap((token, index) => {
    if (token.start < 0 || token.stop < token.start) {
      return [];
    }
    const symbolicName = getSymbolicName(token);
    const type = classifyToken(symbolicName, token.text ?? text.slice(token.start, token.stop + 1), antlrTokens, index);
    return type ? [{ start: token.start, end: token.stop + 1, type }] : [];
  });

  return { issues, tokens };
}

export function getSqlSuggestions(
  text: string,
  offset: number,
  dialect: SqlDialect,
  placeholders: readonly RegExp[],
): Suggestions | null {
  const masked = maskPlaceholders(text, placeholders).text;
  try {
    return getSqlParser(dialect).getSuggestionAtCaretPosition(masked, offsetToCaret(masked, offset));
  } catch {
    return null;
  }
}

export function getSqlEntities(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[] = [],
  offset?: number,
): EntityContext[] {
  const masked = maskPlaceholders(text, placeholders).text;
  try {
    return getSqlParser(dialect).getAllEntities(
      masked,
      offset === undefined ? undefined : offsetToCaret(masked, offset),
    ) ?? [];
  } catch {
    return [];
  }
}

export function lexSql(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[] = [],
): SqlLexToken[] {
  const masked = maskPlaceholders(text, placeholders).text;
  try {
    return getSqlParser(dialect).getAllTokens(masked).flatMap((token) => (
      token.start >= 0 && token.stop >= token.start
        ? [{
            start: token.start,
            end: token.stop + 1,
            text: text.slice(token.start, token.stop + 1),
            symbolicName: getSymbolicName(token),
            channel: token.channel,
          }]
        : []
    ));
  } catch {
    return [];
  }
}

export function offsetToCaret(text: string, offset: number): CaretPosition {
  const safeOffset = Math.min(Math.max(offset, 0), text.length);
  let lineNumber = 1;
  let column = 1;
  for (let index = 0; index < safeOffset; index += 1) {
    const character = text[index];
    if (character === '\r') {
      if (text[index + 1] === '\n' && index + 1 < safeOffset) {
        index += 1;
      }
      lineNumber += 1;
      column = 1;
    } else if (character === '\n') {
      lineNumber += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { lineNumber, column };
}

function findStructuralIssues(
  tokens: readonly Token[],
  statements: readonly SqlStatementSlice[],
): StructuralSqlIssue[] {
  const significant = tokens.filter((token) => token.channel === 0 && token.start >= 0 && token.stop >= token.start);
  const issues: StructuralSqlIssue[] = [];
  const seen = new Set<string>();
  const relationBoundaries = new Set([
    'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
    'QUALIFY', 'WINDOW', 'CLUSTER', 'DISTRIBUTE', 'SORT', 'AND', 'OR', ';', ')',
  ]);
  const expressionBoundaries = new Set([
    'AND', 'OR', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT',
    'EXCEPT', 'QUALIFY', 'WINDOW', 'CLUSTER', 'DISTRIBUTE', 'SORT', ';', ')',
  ]);
  const clauseBoundaries = new Set([
    'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
    'QUALIFY', 'WINDOW', 'CLUSTER', 'DISTRIBUTE', 'SORT', ';', ')',
  ]);
  const listBoundaries = new Set([
    ...relationBoundaries,
    'FROM', 'JOIN', 'ON', 'USING', 'THEN', 'ELSE', 'END', 'WHEN', ']', ',',
  ]);
  const structuralIntroducers = new Set([
    'WITH', 'FROM', 'JOIN', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
    'UNION', 'INTERSECT', 'EXCEPT', 'QUALIFY', 'WINDOW', 'CLUSTER', 'DISTRIBUTE',
    'SORT', 'ON', 'USING',
  ]);
  const structuralAliasBoundaries = new Set([
    ...structuralIntroducers,
    ';', ')', ']', ',',
  ]);

  for (let index = 0; index < significant.length; index += 1) {
    const token = significant[index]!;
    const current = structuralTokenName(token);
    const nextToken = significant[index + 1];
    const next = nextToken ? structuralTokenName(nextToken) : undefined;
    const previousToken = significant[index - 1];
    const previous = previousToken ? structuralTokenName(previousToken) : undefined;

    if (current === 'SELECT' && next === 'FROM' && nextToken) {
      appendStructuralIssue(issues, seen, nextToken, 'Expected a select expression before FROM.');
    }
    if ((current === 'FROM' || current === 'JOIN') && (!next || relationBoundaries.has(next))) {
      appendStructuralIssue(issues, seen, nextToken ?? token, `Expected a relation after ${current}.`);
    }
    if ((current === 'WHERE' || current === 'HAVING' || current === 'ON' || current === 'QUALIFY')
      && (!next || expressionBoundaries.has(next))) {
      appendStructuralIssue(issues, seen, nextToken ?? token, `Expected an expression after ${current}.`);
    }
    if (current === ',' && (!next || listBoundaries.has(next))) {
      appendStructuralIssue(issues, seen, nextToken ?? token, 'Expected a list item after comma.');
    }
    if ((current === 'AND' || current === 'OR')
      && (!next || clauseBoundaries.has(next) || previous === undefined
        || previous === '(' || previous === ',' || previous === 'AND' || previous === 'OR'
        || previous === ';'
        || previous === 'WHERE' || previous === 'HAVING' || previous === 'ON' || previous === 'QUALIFY')) {
      appendStructuralIssue(issues, seen, token, `Boolean operator ${current} is missing an operand.`);
    }
    if (structuralIntroducers.has(current) && previous !== 'AS'
      && (!next || structuralAliasBoundaries.has(next))) {
      appendStructuralIssue(
        issues,
        seen,
        token,
        `Expected clause content after ${current}; use AS or quote it if ${current} is intended as an alias.`,
      );
    }
  }
  return [
    ...issues,
    ...findStatementSeparatorIssues(significant, statements),
    ...findCaseStructuralIssues(significant),
  ];
}

function findStatementSeparatorIssues(
  tokens: readonly Token[],
  statements: readonly SqlStatementSlice[],
): StructuralSqlIssue[] {
  const issues: StructuralSqlIssue[] = [];
  for (let index = 1; index < statements.length; index += 1) {
    const previous = statements[index - 1]!;
    const statement = statements[index]!;
    const hasSeparator = tokens.some((token) => (
      token.text === ';'
      && token.start >= previous.endIndex
      && token.stop < statement.startIndex
    ));
    if (hasSeparator) continue;

    const firstToken = tokens.find((token) => (
      token.start >= statement.startIndex && token.stop <= statement.endIndex
    ));
    if (!firstToken) continue;
    issues.push({
      start: firstToken.start,
      end: firstToken.stop + 1,
      message: 'Expected a semicolon between SQL statements.',
    });
  }
  return issues;
}

interface CaseDiagnosticState {
  caseToken: Token;
  stage: 'before-when' | 'when-condition' | 'then-result' | 'else-result';
  content: boolean;
  pendingToken: Token;
  firstProblem?: { token: Token; message: string };
}

function findCaseStructuralIssues(tokens: readonly Token[]): StructuralSqlIssue[] {
  const issues: StructuralSqlIssue[] = [];
  const stack: CaseDiagnosticState[] = [];
  const documentEnd = tokens.at(-1)?.stop !== undefined ? tokens.at(-1)!.stop + 1 : 0;

  const rememberProblem = (state: CaseDiagnosticState, token: Token, message: string): void => {
    state.firstProblem ??= { token, message };
  };

  const finishCase = (state: CaseDiagnosticState, end: number, closed: boolean): void => {
    if (!state.firstProblem) {
      switch (state.stage) {
        case 'before-when':
          rememberProblem(state, state.caseToken, 'Expected at least one WHEN branch in CASE expression.');
          break;
        case 'when-condition':
          rememberProblem(
            state,
            state.pendingToken,
            state.content
              ? 'Expected THEN after the CASE WHEN condition.'
              : 'Expected an expression after CASE WHEN.',
          );
          break;
        case 'then-result':
          if (!state.content) {
            rememberProblem(state, state.pendingToken, 'Expected an expression after CASE THEN.');
          } else if (!closed) {
            rememberProblem(state, state.caseToken, 'Expected END to close the CASE expression.');
          }
          break;
        case 'else-result':
          if (!state.content) {
            rememberProblem(state, state.pendingToken, 'Expected an expression after CASE ELSE.');
          } else if (!closed) {
            rememberProblem(state, state.caseToken, 'Expected END to close the CASE expression.');
          }
          break;
      }
    }
    const problem = state.firstProblem;
    if (problem) {
      issues.push({
        start: problem.token.start,
        end: problem.token.stop + 1,
        message: problem.message,
        contextStart: state.caseToken.start,
        contextEnd: end,
      });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const current = structuralTokenName(token);
    const previous = tokens[index - 1] ? structuralTokenName(tokens[index - 1]!) : undefined;
    if (current === 'CASE' && previous !== 'END') {
      const parent = stack.at(-1);
      if (parent) parent.content = true;
      stack.push({
        caseToken: token,
        stage: 'before-when',
        content: false,
        pendingToken: token,
      });
      continue;
    }

    const state = stack.at(-1);
    if (!state) continue;

    if (current === 'END') {
      stack.pop();
      finishCase(state, token.stop + 1, true);
      const parent = stack.at(-1);
      if (parent) parent.content = true;
      continue;
    }

    if (current === 'WHEN') {
      if (state.stage === 'before-when') {
        state.stage = 'when-condition';
        state.content = false;
        state.pendingToken = token;
      } else if (state.stage === 'then-result') {
        if (!state.content) {
          rememberProblem(state, state.pendingToken, 'Expected an expression after CASE THEN.');
        }
        state.stage = 'when-condition';
        state.content = false;
        state.pendingToken = token;
      } else if (state.stage === 'when-condition') {
        rememberProblem(
          state,
          state.pendingToken,
          state.content
            ? 'Expected THEN after the CASE WHEN condition.'
            : 'Expected an expression after CASE WHEN.',
        );
        state.content = false;
        state.pendingToken = token;
      } else {
        rememberProblem(state, token, 'WHEN cannot appear after ELSE in a CASE expression.');
      }
      continue;
    }

    if (current === 'THEN' && state.stage === 'when-condition') {
      if (!state.content) {
        rememberProblem(state, state.pendingToken, 'Expected an expression after CASE WHEN.');
      }
      state.stage = 'then-result';
      state.content = false;
      state.pendingToken = token;
      continue;
    }

    if (current === 'ELSE') {
      if (state.stage === 'then-result') {
        if (!state.content) {
          rememberProblem(state, state.pendingToken, 'Expected an expression after CASE THEN.');
        }
      } else if (state.stage === 'before-when') {
        rememberProblem(state, token, 'Expected at least one WHEN branch before CASE ELSE.');
      } else if (state.stage === 'when-condition') {
        rememberProblem(
          state,
          state.pendingToken,
          state.content
            ? 'Expected THEN after the CASE WHEN condition.'
            : 'Expected an expression after CASE WHEN.',
        );
      } else {
        rememberProblem(state, token, 'CASE expression contains more than one ELSE branch.');
      }
      state.stage = 'else-result';
      state.content = false;
      state.pendingToken = token;
      continue;
    }

    state.content = true;
  }

  while (stack.length > 0) {
    finishCase(stack.pop()!, documentEnd, false);
  }
  return issues;
}

function structuralTokenName(token: Token): string {
  const symbolicName = getSymbolicName(token).toUpperCase();
  if (symbolicName.startsWith('KW_')) {
    return symbolicName.slice(3);
  }
  return (token.text ?? '').toUpperCase();
}

function appendStructuralIssue(
  issues: StructuralSqlIssue[],
  seen: Set<string>,
  token: Token,
  message: string,
): void {
  const start = token.start;
  const end = token.stop + 1;
  const key = `${start}:${end}`;
  if (!seen.has(key)) {
    seen.add(key);
    issues.push({ start, end, message });
  }
}

function rangesOverlap(left: SqlIssue, right: SqlIssue): boolean {
  return left.start < right.end && right.start < left.end;
}

function parserIssueCoversStructuralIssue(parserIssue: SqlIssue, structuralIssue: StructuralSqlIssue): boolean {
  if (rangesOverlap(parserIssue, structuralIssue)) return true;
  return structuralIssue.contextStart !== undefined
    && structuralIssue.contextEnd !== undefined
    && parserIssue.start >= structuralIssue.contextStart
    && parserIssue.start <= structuralIssue.contextEnd;
}

function stripStructuralContext(issue: StructuralSqlIssue): SqlIssue {
  return { start: issue.start, end: issue.end, message: issue.message };
}

export function lineColumnToOffset(text: string, oneBasedLine: number, oneBasedColumn: number): number {
  const targetLine = Math.max(oneBasedLine, 1);
  let line = 1;
  let offset = 0;
  while (line < targetLine && offset < text.length) {
    const character = text[offset];
    if (character === '\r') {
      offset += text[offset + 1] === '\n' ? 2 : 1;
      line += 1;
    } else if (character === '\n') {
      offset += 1;
      line += 1;
    } else {
      offset += 1;
    }
  }
  return Math.min(offset + Math.max(oneBasedColumn - 1, 0), text.length);
}

export function getSqlParser(dialect: SqlDialect): ParserLike {
  const existing = parserCache.get(dialect);
  if (existing) {
    return existing;
  }

  let parser: ParserLike;
  switch (dialect) {
    case 'spark': parser = new SparkSQL(); break;
    case 'hive': parser = new HiveSQL(); break;
    case 'flink': parser = new FlinkSQL(); break;
    case 'mysql': parser = new MySQL(); break;
    case 'postgresql': parser = new PostgreSQL(); break;
    case 'trino': parser = new TrinoSQL(); break;
    case 'impala': parser = new ImpalaSQL(); break;
    case 'generic': parser = new GenericSQL(); break;
  }
  parserCache.set(dialect, parser);
  return parser;
}

function parseErrorToIssue(text: string, error: ParseError): SqlIssue {
  const start = lineColumnToOffset(text, error.startLine, error.startColumn);
  let end = lineColumnToOffset(text, error.endLine, error.endColumn);
  if (end <= start) {
    end = Math.min(start + 1, text.length);
  }
  return { start, end, message: error.message };
}

function deduplicateIssues(issues: readonly SqlIssue[]): SqlIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.start}:${issue.end}:${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getSymbolicName(token: Token): string {
  const vocabulary = (token.tokenSource as { vocabulary?: VocabularyLike } | null)?.vocabulary;
  return vocabulary?.getSymbolicName(token.type) ?? '';
}

function classifyToken(
  symbolicName: string,
  text: string,
  tokens: readonly Token[],
  tokenIndex: number,
): SqlTokenType | undefined {
  const name = symbolicName.toUpperCase();
  if (name.includes('COMMENT')) {
    return 'comment';
  }
  if (name.startsWith('KW_')) {
    return 'keyword';
  }
  if (/(?:STRING|CHAR|TEXT|BINARY)_?(?:LITERAL|VALUE)?$/u.test(name) || /^'.*'$/su.test(text)) {
    return 'string';
  }
  if (/(?:NUMBER|NUMERIC|INTEGER|DECIMAL|FLOAT|DOUBLE|REAL|BIGINT|SMALLINT|TINYINT|HEX|DIGIT)(?:_LITERAL|_VALUE)?$/u.test(name)
    || /^\d/u.test(text)) {
    return 'number';
  }
  if (isOperatorName(name) || /^(?:<>|!=|==|<=|>=|=>|[-+*/%=<>|&^~])$/u.test(text)) {
    return 'operator';
  }
  if (name.includes('IDENTIFIER') || name === 'ID' || /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(text)) {
    const next = tokens.slice(tokenIndex + 1).find((candidate) => candidate.channel === 0);
    return next?.text === '(' ? 'function' : 'variable';
  }
  return undefined;
}

function isOperatorName(name: string): boolean {
  return /^(?:EQ|NSEQ|NEQJ?|LT|LTE|GT|GTE|PLUS|MINUS|ASTERISK|SLASH|PERCENT|AMPERSAND|PIPE|CONCAT|CARET|TILDE)$/u.test(name);
}
