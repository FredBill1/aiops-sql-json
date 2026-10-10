import type { CaretPosition, EntityContext, ParseError, Suggestions } from 'dt-sql-parser';
import type { ParserRuleContext, Token } from 'antlr4ng';

import { maskPlaceholders } from './patterns';
import type { SqlDialect } from './sqlDialect';
import {
  classifySqlTokens, getSqlTokenSymbolicName, readSqlLexerTokens, sqlCodePointOffsets, sqlTokenInUtf16,
} from './sqlLexing';
import { getSqlParser } from './sqlParserFactory';
import { normalizeSqlParserGaps } from './sqlParserGaps';
import type { SqlAnalysis, SqlIssue } from './sqlTypes';
import {
  astArgumentRole,
  isSqlAstNode,
  parseSqlAst,
  type ParsedSqlAst,
  type SqlAstNode,
  type SqlAstValue,
} from './sqlAst';

export { SQL_DIALECTS, isSqlDialect, type SqlDialect } from './sqlDialect';
export { lexSql, tokenizeSql } from './sqlLexing';
export { getSqlParser, type ParserLike, type VocabularyLike } from './sqlParserFactory';
export type { SqlAnalysis, SqlIssue, SqlLexToken, SqlToken, SqlTokenType } from './sqlTypes';

interface StructuralSqlIssue extends SqlIssue {
  contextStart?: number;
  contextEnd?: number;
}

interface StructuralScopeState {
  readonly clauses: Set<string>;
  joinHasOn?: boolean;
  mergeNeedsOn: boolean;
}

export function analyzeSql(text: string, dialect: SqlDialect, placeholders: readonly RegExp[]): SqlAnalysis {
  if (text.trim().length === 0) {
    return { issues: [], tokens: [] };
  }

  const parser = getSqlParser(dialect);
  const masked = maskPlaceholders(text, placeholders).text;
  const parserNormalization = normalizeSqlParserGaps(masked, dialect);
  const parserText = parserNormalization.text.replace(/\r(?!\n)/gu, '\n');
  let errors: ParseError[] = [];
  let antlrTokens: Token[] = [];
  let parseTree: ParserRuleContext | undefined;
  try {
    errors = parser.validate(parserText);
    antlrTokens = readSqlLexerTokens(masked, dialect);
    if (errors.length === 0 && hasMultipleTopLevelStatementStarts(antlrTokens)) {
      parseTree = parser.parse(parserText);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      issues: [{ start: 0, end: Math.max(text.length, 1), message: `SQL parser failed: ${message}` }],
      tokens: [],
    };
  }

  const hasUnmaskedTemplate = /\$\{|\$[\p{L}_]/u.test(masked);
  const fallbackAst = !hasUnmaskedTemplate
    && (errors.length > 0 || parseTree !== undefined || hasParenthesizedAliasCandidate(antlrTokens))
    ? parseSqlAst(text, dialect, placeholders)
    : undefined;
  const structuralIssues = findStructuralIssues(antlrTokens, parseTree, fallbackAst, sqlCodePointOffsets(parserText));
  const parserIssues = errors.length > 0 && fallbackAst && structuralIssues.length === 0
    && !parserNormalization.hasMalformedSyntax
    ? []
    : errors.map((error) => parseErrorToIssue(text, parserText, error));
  const uncoveredStructuralIssues = structuralIssues
    .filter((issue) => !parserIssues.some((parserIssue) => parserIssueCoversStructuralIssue(parserIssue, issue)))
    .map(stripStructuralContext);
  const issues = deduplicateIssues([...parserIssues, ...uncoveredStructuralIssues]);
  return { issues, tokens: classifySqlTokens(antlrTokens) };
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
  parseTree?: ParserRuleContext,
  ast?: ParsedSqlAst,
  parseTreeOffsets?: readonly number[],
): StructuralSqlIssue[] {
  const significant = tokens.filter((token) => token.channel === 0 && token.start >= 0 && token.stop >= token.start);
  const issues: StructuralSqlIssue[] = [];
  const seen = new Set<string>();
  const relationBoundaries = new Set([
    'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
    'QUALIFY', 'WINDOW', 'CLUSTER', 'DISTRIBUTE', 'SORT', 'AND', 'OR', 'SELECT', 'WITH',
    ';', ')',
  ]);
  const expressionBoundaries = new Set([
    'AND', 'OR', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT',
    'EXCEPT', 'QUALIFY', 'WINDOW', 'CLUSTER', 'DISTRIBUTE', 'SORT', 'SELECT', 'VALUES', 'WITH',
    ';', ')', ',',
  ]);
  const clauseBoundaries = new Set([
    'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
    'QUALIFY', 'WINDOW', 'CLUSTER', 'DISTRIBUTE', 'SORT', ';', ')',
  ]);
  const listBoundaries = new Set([
    ...relationBoundaries,
    'FROM', 'JOIN', 'ON', 'USING', 'THEN', 'ELSE', 'END', 'WHEN', ']', ',',
  ]);
  const queryStarts = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
  const statementStarts = new Set(['SELECT', 'WITH', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TABLE']);
  const terminators = new Set([';', ')']);
  const structuralScopes: StructuralScopeState[] = [createStructuralScopeState()];
  const joinBoundaries = new Set([
    'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'QUALIFY', 'ORDER', 'LIMIT', 'OFFSET',
    'UNION', 'INTERSECT', 'EXCEPT', 'WHEN', 'SET', ';',
  ]);
  let caseDepth = 0;

  for (let index = 0; index < significant.length; index += 1) {
    const token = significant[index]!;
    const current = structuralTokenName(token);
    const nextToken = significant[index + 1];
    const next = nextToken ? structuralTokenName(nextToken) : undefined;
    const previousToken = significant[index - 1];
    const previous = previousToken ? structuralTokenName(previousToken) : undefined;
    const afterNextToken = significant[index + 2];
    const afterNext = afterNextToken ? structuralTokenName(afterNextToken) : undefined;

    if (current === ')' && structuralScopes.length > 1) structuralScopes.pop();
    const structuralScope = structuralScopes.at(-1)!;
    const atBoundary = (value: string | undefined): boolean => value === undefined || expressionBoundaries.has(value);

    if (current === 'SELECT'
      && (atBoundary(next) || ((next === 'ALL' || next === 'DISTINCT') && atBoundary(afterNext)))) {
      appendStructuralIssue(issues, seen, nextToken ?? token, 'Expected a select expression after SELECT.');
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
    if (current === ',' && (previous === undefined || previous === '(' || previous === ','
      || previous === 'SELECT' || previous === 'VALUES')) {
      appendStructuralIssue(issues, seen, token, 'Expected a list item before comma.');
    }
    if ((current === 'AND' || current === 'OR')
      && (!next || clauseBoundaries.has(next) || previous === undefined
        || previous === '(' || previous === ',' || previous === 'AND' || previous === 'OR'
        || previous === ';'
        || previous === 'WHERE' || previous === 'HAVING' || previous === 'ON' || previous === 'QUALIFY')) {
      appendStructuralIssue(issues, seen, token, `Boolean operator ${current} is missing an operand.`);
    }

    if (current === 'AS' && (next === undefined || next === ';' || next === ')' || next === ',')) {
      appendStructuralIssue(issues, seen, nextToken ?? token, 'Expected an alias or type after AS.');
    }
    if ((current === 'GROUP' || current === 'ORDER') && next !== 'BY' && next !== '(') {
      appendStructuralIssue(issues, seen, nextToken ?? token, `Expected BY after ${current}.`);
    }
    if ((current === 'GROUP' || current === 'ORDER') && next === 'BY' && atBoundary(afterNext)) {
      appendStructuralIssue(issues, seen, afterNextToken ?? nextToken ?? token, `Expected an expression after ${current} BY.`);
    }
    if ((current === 'LIMIT' || current === 'OFFSET' || current === 'WINDOW' || current === 'OVER')
      && atBoundary(next)) {
      appendStructuralIssue(issues, seen, nextToken ?? token, `Expected a value after ${current}.`);
    }
    if ((current === 'IN' || current === 'IS' || current === 'NOT') && atBoundary(next)) {
      appendStructuralIssue(issues, seen, nextToken ?? token, `Expected an expression after ${current}.`);
    }
    if (current === 'IN' && next === '(' && (afterNext === ')' || afterNext === ',')) {
      appendStructuralIssue(issues, seen, afterNextToken ?? nextToken ?? token, 'Expected a value or query inside IN parentheses.');
    }
    if (current === '(' && next === ')' && ['SELECT', 'VALUES', 'IN', 'EXISTS', 'USING'].includes(previous ?? '')) {
      appendStructuralIssue(issues, seen, nextToken ?? token, `Expected content inside ${previous ?? ''} parentheses.`);
    }
    if (current === 'VALUES' && (next === undefined || next === ';' || next === ')')) {
      appendStructuralIssue(issues, seen, nextToken ?? token, 'Expected at least one row after VALUES.');
    }
    if (current === 'WITH' && (next === undefined || terminators.has(next))) {
      appendStructuralIssue(issues, seen, nextToken ?? token, 'Expected a common table expression after WITH.');
    }
    if (current === 'DISTINCT' && previous === 'SELECT' && atBoundary(next)) {
      appendStructuralIssue(issues, seen, nextToken ?? token, 'Expected a select expression after DISTINCT.');
    }
    if (current === 'UNION' || current === 'INTERSECT' || current === 'EXCEPT') {
      const rightStart = next === 'ALL' || next === 'DISTINCT' ? afterNext : next;
      if (!rightStart || !queryStarts.has(rightStart) && rightStart !== '(') {
        appendStructuralIssue(issues, seen, nextToken ?? token, `Expected a query after ${current}.`);
      }
    }

    if (current === 'CASE') caseDepth += 1;
    if (current === 'END') {
      if (caseDepth === 0 && previous !== undefined && previous !== ';') {
        appendStructuralIssue(issues, seen, token, 'END does not close a CASE expression.');
      } else {
        caseDepth = Math.max(caseDepth - 1, 0);
      }
    }

    if (current === ';') {
      structuralScopes.splice(0, structuralScopes.length, createStructuralScopeState());
    } else if (current === 'SELECT' || current === 'VALUES') {
      structuralScope.clauses.clear();
      structuralScope.joinHasOn = undefined;
    } else if (current === 'ORDER' && next === 'BY') {
      if (structuralScope.clauses.has('ORDER BY')) {
        appendStructuralIssue(issues, seen, token, 'ORDER BY appears more than once in the same query.');
      }
      structuralScope.clauses.add('ORDER BY');
    } else if (current === 'LIMIT') {
      if (structuralScope.clauses.has('LIMIT')) {
        appendStructuralIssue(issues, seen, token, 'LIMIT appears more than once in the same query.');
      }
      structuralScope.clauses.add('LIMIT');
    }
    if (current === 'MERGE') structuralScope.mergeNeedsOn = true;
    if (joinBoundaries.has(current)) structuralScope.joinHasOn = undefined;
    if (current === 'JOIN') structuralScope.joinHasOn = false;
    if (current === 'ON') {
      const startsConflictClause = next === 'CONFLICT' || next === 'DUPLICATE';
      if (startsConflictClause) {
        structuralScope.joinHasOn = undefined;
      } else if (structuralScope.joinHasOn === false) {
        structuralScope.joinHasOn = true;
      } else if (structuralScope.joinHasOn && structuralScope.mergeNeedsOn) {
        structuralScope.joinHasOn = undefined;
        structuralScope.mergeNeedsOn = false;
      } else if (structuralScope.joinHasOn) {
        appendStructuralIssue(issues, seen, token, 'JOIN contains more than one ON clause.');
      } else if (structuralScope.mergeNeedsOn) {
        structuralScope.mergeNeedsOn = false;
      }
    }

    if (current === '(') structuralScopes.push(createStructuralScopeState());
  }

  appendCteStructuralIssues(significant, issues, seen, statementStarts);
  appendAlterStructuralIssues(significant, issues, seen);
  if (parseTree) appendStatementSeparatorIssues(parseTree, issues, seen, ast, parseTreeOffsets);
  if (ast) appendAstStructuralIssues(ast, significant, issues, seen);
  return [...issues, ...findCaseStructuralIssues(significant)];
}

function createStructuralScopeState(): StructuralScopeState {
  return { clauses: new Set(), mergeNeedsOn: false };
}

function appendCteStructuralIssues(
  tokens: readonly Token[],
  issues: StructuralSqlIssue[],
  seen: Set<string>,
  statementStarts: ReadonlySet<string>,
): void {
  for (let statementStart = 0; statementStart < tokens.length;) {
    let statementEnd = tokens.findIndex((token, index) => index >= statementStart && structuralTokenName(token) === ';');
    if (statementEnd < 0) statementEnd = tokens.length;
    if (structuralTokenName(tokens[statementStart]!) === 'WITH') {
      let depth = 0;
      let hasMainStatement = false;
      for (let index = statementStart + 1; index < statementEnd; index += 1) {
        const current = structuralTokenName(tokens[index]!);
        if (current === '(') depth += 1;
        else if (current === ')') depth = Math.max(depth - 1, 0);
        else if (depth === 0 && statementStarts.has(current)) {
          hasMainStatement = true;
          break;
        }
      }
      if (!hasMainStatement) {
        appendStructuralIssue(issues, seen, tokens[Math.max(statementEnd - 1, statementStart)]!, 'Expected a main statement after WITH clause.');
      }
    }
    statementStart = statementEnd + 1;
  }
}

function appendAlterStructuralIssues(
  tokens: readonly Token[],
  issues: StructuralSqlIssue[],
  seen: Set<string>,
): void {
  const actions = new Set([
    'ADD', 'ALTER', 'CHANGE', 'DROP', 'MODIFY', 'RENAME', 'REPLACE', 'SET', 'UNSET', 'ENABLE',
    'DISABLE', 'OWNER', 'CLUSTER', 'PARTITION', 'RECOVER', 'EXECUTE',
  ]);
  for (let statementStart = 0; statementStart < tokens.length;) {
    let statementEnd = tokens.findIndex((token, index) => index >= statementStart && structuralTokenName(token) === ';');
    if (statementEnd < 0) statementEnd = tokens.length;
    if (structuralTokenName(tokens[statementStart]!) === 'ALTER'
      && structuralTokenName(tokens[statementStart + 1]!) === 'TABLE') {
      const action = tokens.slice(statementStart + 2, statementEnd).find((token) => actions.has(structuralTokenName(token)));
      if (!action) {
        appendStructuralIssue(issues, seen, tokens[Math.max(statementEnd - 1, statementStart)]!, 'Expected an ALTER TABLE action.');
      }
    }
    statementStart = statementEnd + 1;
  }
}

interface RootContextChild {
  readonly start?: Token;
  readonly stop?: Token;
  readonly symbol?: Token;
}

function appendStatementSeparatorIssues(
  root: ParserRuleContext,
  issues: StructuralSqlIssue[],
  seen: Set<string>,
  ast: ParsedSqlAst | undefined,
  offsets: readonly number[] | undefined,
): void {
  const children = ((root as unknown as { children?: readonly RootContextChild[] }).children ?? [])
    .map((child) => ({
      symbol: child.symbol,
      start: child.start && sqlTokenInUtf16(child.start, offsets),
      stop: child.stop && sqlTokenInUtf16(child.stop, offsets),
    }))
    .filter((child) => child.symbol === undefined && child.start && child.stop
      && child.start.start >= 0 && child.stop.stop >= child.start.start)
    .sort((left, right) => left.start!.start - right.start!.start);
  let previous: RootContextChild | undefined;
  for (const child of children) {
    const sameStatement = previous && ast?.statements.some((statement) => (
      statement.start <= previous!.stop!.stop && statement.end > child.start!.start
    ));
    if (previous && !sameStatement && previous.stop?.text !== ';' && child.start!.start > previous.stop!.stop) {
      appendStructuralIssue(issues, seen, child.start!, 'Expected a semicolon between SQL statements.');
    }
    if (!previous || child.stop!.stop >= previous.stop!.stop) previous = child;
  }
}

function appendAstStructuralIssues(
  ast: ParsedSqlAst,
  tokens: readonly Token[],
  issues: StructuralSqlIssue[],
  seen: Set<string>,
): void {
  const visit = (node: SqlAstNode, parent?: SqlAstNode, argument?: string): void => {
    const rowConstructorField = parent?.role === 'function'
      && parent.kind === 'anonymous'
      && parent.name.replace(/^!/u, '').toLocaleLowerCase() === 'struct';
    if (node.role === 'alias'
      && !(parent && argument && astArgumentRole(parent, argument) === 'projection')
      && !(node.kind === 'pivotAlias' && parent?.kind === 'in' && argument === 'expressions')
      && !rowConstructorField) {
      const asToken = tokens.find((token) => token.start >= node.start && token.stop < node.end
        && structuralTokenName(token) === 'AS');
      appendStructuralIssue(
        issues,
        seen,
        asToken ?? tokens.find((token) => token.start >= node.start && token.stop < node.end) ?? tokens[0]!,
        'Aliases are only valid on select items and relations, not inside scalar expressions.',
      );
    }
    for (const [key, value] of Object.entries(node.args)) visitAstValue(value, node, key, visit);
  };
  for (const statement of ast.statements) visit(statement);
}

function visitAstValue(
  value: SqlAstValue,
  parent: SqlAstNode,
  argument: string,
  visit: (node: SqlAstNode, parent?: SqlAstNode, argument?: string) => void,
): void {
  if (isSqlAstNode(value)) {
    visit(value, parent, argument);
  } else if (Array.isArray(value)) {
    for (const child of value) if (isSqlAstNode(child)) visit(child, parent, argument);
  }
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

function hasMultipleTopLevelStatementStarts(tokens: readonly Token[]): boolean {
  const starts = new Set(['ALTER', 'CREATE', 'DELETE', 'DROP', 'INSERT', 'MERGE', 'SELECT', 'UPDATE', 'VALUES', 'WITH']);
  let depth = 0;
  let count = 0;
  for (const token of tokens) {
    if (token.channel !== 0 || token.start < 0 || token.stop < token.start) continue;
    const current = structuralTokenName(token);
    if (current === ')') depth = Math.max(depth - 1, 0);
    if (depth === 0 && starts.has(current)) {
      count += 1;
      if (count > 1) return true;
    }
    if (current === '(') depth += 1;
  }
  return false;
}

function hasParenthesizedAliasCandidate(tokens: readonly Token[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.channel !== 0 || token.start < 0 || token.stop < token.start) continue;
    const current = structuralTokenName(token);
    if (current === ')') depth = Math.max(depth - 1, 0);
    if (current === 'AS' && depth > 0) return true;
    if (current === '(') depth += 1;
  }
  return false;
}

function structuralTokenName(token: Token | undefined): string {
  if (!token) return '';
  const symbolicName = getSqlTokenSymbolicName(token).toUpperCase();
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

function parserColumnToOffset(text: string, oneBasedLine: number, oneBasedColumn: number): number {
  let offset = lineColumnToOffset(text, oneBasedLine, 1);
  for (let column = 1; column < oneBasedColumn && offset < text.length; column += 1) {
    if (text[offset] === '\r' || text[offset] === '\n') break;
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }
  return offset;
}

function parseErrorToIssue(text: string, parserText: string, error: ParseError): SqlIssue {
  const start = parserColumnToOffset(parserText, error.startLine, error.startColumn);
  // DT's listener reports a code-point start column, then adds token.text.length
  // (UTF-16) to derive the end column. Convert the start before adding that width.
  let end = error.endLine === error.startLine
    ? Math.min(start + Math.max(error.endColumn - error.startColumn, 0), text.length)
    : parserColumnToOffset(parserText, error.endLine, error.endColumn);
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
