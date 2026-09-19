import { describe, expect, it } from 'vitest';

import { lexSql, SQL_DIALECTS } from '../../src/sql';
import { formatSql } from '../../src/sqlFormatting';
import { commentCases, commentFormat, commentSql, dialectCommentCases } from './sql-comment-whitespace.cases';

const cases = [
  ...SQL_DIALECTS.flatMap((dialect) => commentCases.map(([name, sql]) => ({ dialect, name, sql }))),
  ...dialectCommentCases,
];

const variants = [
  { name: 'space / LF', whitespace: ' ', eol: '\n' },
  { name: 'tab / LF', whitespace: '\t', eol: '\n' },
  { name: 'mixed spaces and tab / CRLF', whitespace: ' \t  ', eol: '\r\n' },
  { name: 'NBSP / LF', whitespace: '\u00a0', eol: '\n' },
  { name: 'ideographic space / LF', whitespace: '\u3000', eol: '\n' },
];

// Removing comment suffix whitespace is safe; string/block-comment contents are not.
// Separate passing controls establish that these are not unsupported SQL fixtures.
describe('comment whitespace: clean controls', () => {
  it.each(cases)('$dialect: $name', ({ dialect, sql }) => {
    const editor = { tabSize: 2, insertSpaces: true, eol: '\n' };
    const clean = formatSql(commentSql(sql, ''), dialect, [], commentFormat, editor).text;
    expect(clean).not.toBe('');
    expect(formatSql(clean, dialect, [], commentFormat, editor).text).toBe(clean);
  });
});

describe.each(variants)('comment whitespace: $name', ({ whitespace, eol }) => {
  it.each(cases)('$dialect: $name', ({ dialect, sql }) => {
    const editor = { tabSize: 2, insertSpaces: true, eol };
    const expected = formatSql(commentSql(sql, '', eol), dialect, [], commentFormat, editor).text;
    const actual = formatSql(commentSql(sql, whitespace, eol), dialect, [], commentFormat, editor).text;
    expect(actual).toBe(expected);
    expect(formatSql(actual, dialect, [], commentFormat, editor).text).toBe(actual);
  });
});

describe.each(SQL_DIALECTS)('%s: comment layout and preservation boundaries', (dialect) => {
  it('keeps UTF-16 source ranges and original CR spelling at the lexer boundary', () => {
    const sql = "select '😀' as a, '𠮷😀' as b /* 😀\rkeep  */ -- 😀\rselect 'keep\rvalue'";
    const tokens = lexSql(sql, dialect);
    expect(tokens.map((token) => token.text).join('')).toBe(sql);
    expect(tokens.filter((token) => token.text.toLowerCase() === 'select').map((token) => token.start))
      .toEqual([0, sql.lastIndexOf('select')]);
    expect(tokens.find((token) => token.text === "'keep\rvalue'"))
      .toMatchObject({ start: sql.indexOf("'keep"), end: sql.length });
    for (const token of tokens) {
      expect(sql.slice(token.start, token.end)).toBe(token.text);
      expect(token.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    }
  });
  it.each(['compact', 'expanded'] as const)('trims comments with %s layout and tab indentation', (layoutMode) => {
    const configuration = { ...commentFormat, layoutMode, maxLineWidth: 40 };
    const editor = { tabSize: 4, insertSpaces: false, eol: '\r\n' };
    const template = commentCases[0][1];
    const expected = formatSql(commentSql(template, '', editor.eol), dialect, [], configuration, editor).text;
    expect(formatSql(commentSql(template, ' \t ', editor.eol), dialect, [], configuration, editor).text).toBe(expected);
  });

  it('preserves spaces inside literals, quoted identifiers, and block comments', () => {
    const quoted = ['postgresql', 'trino'].includes(dialect) ? '"keep  "' : '`keep  `';
    const sql = `select 'keep  ' as ${quoted} /* first  \nsecond\t\n */`;
    const actual = formatSql(sql, dialect, [], commentFormat, { tabSize: 2, insertSpaces: true, eol: '\n' }).text;
    expect(actual).toContain("'keep  '");
    expect(actual).toContain(quoted);
    expect(actual).toContain('/* first  \nsecond\t\n */');
  });

  describe('bare CR comment terminators', () => {
    for (const whitespace of ['', ' ']) {
      it.each([commentCases[0], commentCases[1], commentCases[14], commentCases[34]])(
        `%s / suffix=${JSON.stringify(whitespace)}`,
        (_name, template) => {
          const editor = { tabSize: 2, insertSpaces: true, eol: '\n' };
          const expected = formatSql(commentSql(template, ''), dialect, [], commentFormat, editor).text;
          // Normalize output to LF; a CR in the input must still end a comment.
          const actual = formatSql(commentSql(template, whitespace, '\r'), dialect, [], commentFormat, editor).text;
          expect(actual).toBe(expected);
        },
      );
    }
  });

  it.each([
    ['line EOF', 'select 1 -- 😀'],
    ['line LF', 'select 1 -- 😀\n'],
    ['leading line', '-- 😀\nselect 1'],
    ['line before FROM', 'select a -- 😀 note\nfrom source_table'],
    ['inline block', 'select /* 😀 */ 1'],
    ['leading block', '/* 😀 */ select 1'],
  ])('preserves an astral character in a %s comment', (_name, sql) => {
    const editor = { tabSize: 2, insertSpaces: true, eol: '\n' };
    const control = formatSql(sql!.replace('😀', 'note'), dialect, [], commentFormat, editor).text;
    const actual = formatSql(sql!, dialect, [], commentFormat, editor).text;
    // Also catches split surrogate pairs where the formatter does not throw.
    expect(actual).toBe(control.replace('note', '😀'));
    expect(formatSql(actual, dialect, [], commentFormat, editor).text).toBe(actual);
  });
});

describe('MySQL hash comment terminators', () => {
  it.each(commentCases)('applies the same line-comment layout rules at %s', (_name, template) => {
    const editor = { tabSize: 2, insertSpaces: true, eol: '\n' };
    const expected = formatSql(commentSql(template, ''), 'mysql', [], commentFormat, editor).text.replaceAll('--', '#');
    const sql = commentSql(template, ' \t ').replaceAll('--', '#');
    const actual = formatSql(sql, 'mysql', [], commentFormat, editor).text;
    expect(actual).toBe(expected);
    expect(formatSql(actual, 'mysql', [], commentFormat, editor).text).toBe(actual);
  });

  it.each(['\n', '\r\n'])('accepts a final hash comment terminated with %j', (eol) => {
    const editor = { tabSize: 2, insertSpaces: true, eol };
    const expected = formatSql('select 1 # test', 'mysql', [], commentFormat, editor).text;
    expect(formatSql(`select 1 # test${eol}`, 'mysql', [], commentFormat, editor).text).toBe(expected);
  });
});
