import { describe, expect, it } from 'vitest';

import { analyzeSqlEditingStructure, findBracketAt, lexicalStateAt } from '../../src/editingCore';
import { decodedOffsetAtOriginalOffset, type DecodedSqlText } from '../../src/regions';

describe('SQL editing structure', () => {
  it('pairs nested brackets and records both shared and per-type levels', () => {
    const structure = analyzeSqlEditingStructure('func({[value]})');
    const brackets = structure.brackets;

    expect(brackets.map((item) => item.character)).toEqual(['(', '{', '[', ']', '}', ')']);
    expect(brackets.map((item) => item.level)).toEqual([0, 1, 2, 2, 1, 0]);
    expect(brackets.map((item) => item.independentLevel)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(brackets.every((item) => !item.unexpected && item.pairOffset !== undefined)).toBe(true);
    expect(findBracketAt(structure, 5)?.character).toBe('(');
    expect(findBracketAt(structure, 6)?.character).toBe('{');
  });

  it('marks mismatched brackets as unexpected', () => {
    const structure = analyzeSqlEditingStructure('([)]');
    expect(structure.brackets.map((item) => ({ char: item.character, unexpected: item.unexpected }))).toEqual([
      { char: '(', unexpected: true },
      { char: '[', unexpected: false },
      { char: ')', unexpected: true },
      { char: ']', unexpected: false },
    ]);
  });

  it('ignores brackets in quoted identifiers, strings, and comments', () => {
    const sql = "SELECT '(', \"[\", `{`, /* ) */ func(value) -- ]\n[array_value]";
    const structure = analyzeSqlEditingStructure(sql);

    expect(structure.brackets.map((item) => item.character)).toEqual(['(', ')', '[', ']']);
    expect(lexicalStateAt(structure, sql.indexOf('(', sql.indexOf('func')))).toBe('code');
    expect(lexicalStateAt(structure, sql.indexOf(']', sql.indexOf('--')))).toBe('lineComment');
    expect(lexicalStateAt(structure, sql.lastIndexOf('['))).toBe('code');
  });

  it('tracks escaped and doubled SQL quotes while editing incomplete text', () => {
    const sql = "'it''s' \"a\\\"b\" `name` 'open";
    const structure = analyzeSqlEditingStructure(sql);

    expect(lexicalStateAt(structure, sql.indexOf('it'))).toBe('singleQuote');
    expect(lexicalStateAt(structure, sql.indexOf('a'))).toBe('doubleQuote');
    expect(lexicalStateAt(structure, sql.indexOf('name'))).toBe('backtick');
    expect(lexicalStateAt(structure, sql.length)).toBe('singleQuote');
  });

  it('pairs template placeholder braces without treating their contents as SQL strings', () => {
    const structure = analyzeSqlEditingStructure('SELECT ${day}, {{ partition }}');
    expect(structure.brackets.map((item) => item.character)).toEqual(['{', '}', '{', '{', '}', '}']);
    expect(structure.brackets.every((item) => item.pairOffset !== undefined && !item.unexpected)).toBe(true);
  });
});

describe('decoded SQL offsets', () => {
  it('maps source boundaries across JSON escape spans', () => {
    const decoded: DecodedSqlText = {
      text: 'a"b',
      spans: [
        { start: 10, end: 11 },
        { start: 11, end: 13 },
        { start: 13, end: 14 },
      ],
      fallbackOffset: 10,
    };

    expect(decodedOffsetAtOriginalOffset(decoded, 10)).toBe(0);
    expect(decodedOffsetAtOriginalOffset(decoded, 11)).toBe(1);
    expect(decodedOffsetAtOriginalOffset(decoded, 12)).toBe(2);
    expect(decodedOffsetAtOriginalOffset(decoded, 13)).toBe(2);
    expect(decodedOffsetAtOriginalOffset(decoded, 14)).toBe(3);
  });
});
