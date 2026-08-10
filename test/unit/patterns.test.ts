import { describe, expect, it } from 'vitest';

import {
  compileGlobs,
  compilePlaceholderPatterns,
  maskPlaceholders,
  matchesAnyGlob,
} from '../../src/patterns';

describe('patterns', () => {
  it('matches full, case-sensitive glob patterns', () => {
    const patterns = compileGlobs(['*Sql', 'sql_?']);
    expect(matchesAnyGlob('trainSql', patterns)).toBe(true);
    expect(matchesAnyGlob('sql_a', patterns)).toBe(true);
    expect(matchesAnyGlob('trainSQL', patterns)).toBe(false);
    expect(matchesAnyGlob('prefixSqlSuffix', patterns)).toBe(false);
  });

  it('masks placeholders without moving UTF-16 offsets or line endings', () => {
    const compiled = compilePlaceholderPatterns(['\\$\\{[^}]+\\}', '\\{\\{[\\s\\S]+?\\}\\}']);
    expect(compiled.issues).toEqual([]);
    const input = 'SELECT ${table😀}\nFROM {{ table }}';
    const result = maskPlaceholders(input, compiled.patterns);
    expect(result.text).toHaveLength(input.length);
    expect(result.text.split('\n')).toHaveLength(2);
    expect(result.text).not.toContain('${');
    expect(result.ranges).toHaveLength(2);
  });

  it('rejects invalid and empty-matching placeholder expressions', () => {
    const compiled = compilePlaceholderPatterns(['[', '.*']);
    expect(compiled.patterns).toHaveLength(0);
    expect(compiled.issues).toHaveLength(2);
  });
});
