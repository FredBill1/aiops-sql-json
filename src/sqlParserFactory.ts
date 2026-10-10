import {
  FlinkSQL, GenericSQL, HiveSQL, ImpalaSQL, MySQL, PostgreSQL, SparkSQL, TrinoSQL,
} from 'dt-sql-parser';
import type { CaretPosition, EntityContext, ParseError, Suggestions } from 'dt-sql-parser';
import type { ParserRuleContext, Token } from 'antlr4ng';

import type { SqlDialect } from './sqlDialect';

export interface VocabularyLike {
  readonly maxTokenType: number;
  getLiteralName(tokenType: number): string | null;
  getSymbolicName(tokenType: number): string | null;
}

export interface LexerLike {
  readonly vocabulary: VocabularyLike;
  getAllTokens(): Token[];
  removeErrorListeners(): void;
}

export interface ParserLike {
  parse(input: string): ParserRuleContext;
  validate(input: string): ParseError[];
  getAllTokens(input: string): Token[];
  getSuggestionAtCaretPosition(input: string, caretPosition: CaretPosition): Suggestions | null;
  getAllEntities(input: string, caretPosition?: CaretPosition): EntityContext[] | null;
  createLexer(input: string): LexerLike;
}

const parserCache = new Map<SqlDialect, ParserLike>();

export function getSqlParser(dialect: SqlDialect): ParserLike {
  const existing = parserCache.get(dialect);
  if (existing) return existing;

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
