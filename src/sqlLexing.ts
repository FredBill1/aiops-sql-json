import type { Token } from 'antlr4ng';

import { maskPlaceholders } from './patterns';
import type { SqlDialect } from './sqlDialect';
import { getSqlParser, type VocabularyLike } from './sqlParserFactory';
import type { SqlLexToken, SqlToken, SqlTokenType } from './sqlTypes';

/** ANTLR indexes code points; the editor and every exported token use UTF-16. */
export function sqlCodePointOffsets(text: string): readonly number[] | undefined {
  if (!/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) return undefined;
  const offsets = [0];
  for (const character of text) offsets.push(offsets[offsets.length - 1]! + character.length);
  return offsets;
}

export function sqlTokenInUtf16(token: Token, offsets: readonly number[] | undefined): Token {
  if (!offsets || token.start < 0 || token.stop < token.start) return token;
  // Keep explicit spelling before changing offsets: CommonToken.text otherwise
  // reads its code-point input stream using the new UTF-16 bounds.
  return {
    text: token.text,
    type: token.type,
    line: token.line,
    column: token.column,
    channel: token.channel,
    tokenIndex: token.tokenIndex,
    start: offsets[token.start]!,
    stop: offsets[token.stop + 1]! - 1,
    tokenSource: token.tokenSource,
    inputStream: token.inputStream,
  };
}

/** Internal token snapshots for structural validation, without invoking a parser. */
export function readSqlLexerTokens(text: string, dialect: SqlDialect): Token[] {
  const lexerText = text.replace(/\r(?!\n)/gu, '\n');
  const offsets = sqlCodePointOffsets(lexerText);
  const lexer = getSqlParser(dialect).createLexer(lexerText);
  lexer.removeErrorListeners();
  return lexer.getAllTokens().map((token) => sqlTokenInUtf16(token, offsets));
}

export function getSqlTokenSymbolicName(token: Token): string {
  const vocabulary = (token.tokenSource as { vocabulary?: VocabularyLike } | null)?.vocabulary;
  return vocabulary?.getSymbolicName(token.type) ?? '';
}

/** Semantic highlighting is lexical and stays useful while SQL is incomplete. */
export function tokenizeSql(
  text: string,
  dialect: SqlDialect,
  placeholders: readonly RegExp[] = [],
): SqlToken[] {
  const masked = maskPlaceholders(text, placeholders).text;
  try {
    return classifySqlTokens(readSqlLexerTokens(masked, dialect));
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
    return readSqlLexerTokens(masked, dialect).flatMap((token) => (
      token.start >= 0 && token.stop >= token.start
        ? [{
            start: token.start,
            end: token.stop + 1,
            text: text.slice(token.start, token.stop + 1),
            symbolicName: getSqlTokenSymbolicName(token),
            channel: token.channel,
          }]
        : []
    ));
  } catch {
    return [];
  }
}

/** A backward pass finds the next default-channel token once for each token. */
export function classifySqlTokens(tokens: readonly Token[]): SqlToken[] {
  const classified: SqlToken[] = [];
  let nextDefaultText: string | null | undefined;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    const text = token.text;
    let type: SqlTokenType | undefined;
    if (token.start >= 0 && token.stop >= token.start) {
      type = classifyToken(getSqlTokenSymbolicName(token), text ?? '', nextDefaultText);
      if (type) classified.push({ start: token.start, end: token.stop + 1, type });
    }
    if (token.channel === 0 && type !== 'comment') nextDefaultText = text;
  }
  return classified.reverse();
}

function classifyToken(symbolicName: string, text: string, nextText: string | null | undefined): SqlTokenType | undefined {
  const name = symbolicName.toUpperCase();
  if (name.includes('COMMENT') || name === 'QUERY_HINT') return 'comment';
  if (name.startsWith('KW_')) return 'keyword';
  if (/(?:STRING|CHAR|TEXT|BINARY)_?(?:LITERAL|VALUE)?$/u.test(name) || /^'.*'$/su.test(text)) return 'string';
  if (/(?:NUMBER|NUMERIC|INTEGER|DECIMAL|FLOAT|DOUBLE|REAL|BIGINT|SMALLINT|TINYINT|HEX|DIGIT)(?:_LITERAL|_VALUE)?$/u.test(name)
    || /^\d/u.test(text)) return 'number';
  if (/^(?:EQ|NSEQ|NEQJ?|LT|LTE|GT|GTE|PLUS|MINUS|ASTERISK|SLASH|PERCENT|AMPERSAND|PIPE|CONCAT|CARET|TILDE)$/u.test(name)
    || /^(?:<>|!=|==|<=|>=|=>|[-+*/%=<>|&^~])$/u.test(text)) return 'operator';
  if (name.includes('IDENTIFIER') || name === 'ID' || /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(text)) {
    return nextText === '(' ? 'function' : 'variable';
  }
  return undefined;
}
