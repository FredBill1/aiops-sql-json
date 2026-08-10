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
import type { ParseError } from 'dt-sql-parser';
import type { Token } from 'antlr4ng';

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

interface ParserLike {
  validate(input: string): ParseError[];
  getAllTokens(input: string): Token[];
}

interface VocabularyLike {
  getSymbolicName(tokenType: number): string | null;
}

const parserCache = new Map<SqlDialect, ParserLike>();

export function isSqlDialect(value: unknown): value is SqlDialect {
  return typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value);
}

export function analyzeSql(text: string, dialect: SqlDialect, placeholders: readonly RegExp[]): SqlAnalysis {
  if (text.trim().length === 0) {
    return { issues: [], tokens: [] };
  }

  const parser = getParser(dialect);
  const masked = maskPlaceholders(text, placeholders).text;
  let errors: ParseError[] = [];
  let antlrTokens: Token[] = [];
  try {
    errors = parser.validate(masked);
    antlrTokens = parser.getAllTokens(masked);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      issues: [{ start: 0, end: Math.max(text.length, 1), message: `SQL parser failed: ${message}` }],
      tokens: [],
    };
  }

  const issues = deduplicateIssues(errors.map((error) => parseErrorToIssue(text, error)));
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

function getParser(dialect: SqlDialect): ParserLike {
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
