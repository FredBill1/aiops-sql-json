export type { SqlDialect } from './sqlDialect';

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

export interface SqlLexToken {
  start: number;
  end: number;
  text: string;
  symbolicName: string;
  channel: number;
}
