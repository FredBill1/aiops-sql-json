export interface CompiledPlaceholderPatterns {
  patterns: RegExp[];
  issues: string[];
}

export interface MaskedSql {
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export function compileGlob(pattern: string): RegExp {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') {
      source += '.*';
    } else if (character === '?') {
      source += '.';
    } else {
      source += escapeRegularExpression(character);
    }
  }
  return new RegExp(`${source}$`, 'u');
}

export function compileGlobs(patterns: readonly string[]): RegExp[] {
  return patterns.map(compileGlob);
}

export function matchesAnyGlob(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function compilePlaceholderPatterns(sources: readonly string[]): CompiledPlaceholderPatterns {
  const patterns: RegExp[] = [];
  const issues: string[] = [];
  for (const source of sources) {
    try {
      const expression = new RegExp(source, 'gu');
      if (expression.test('')) {
        issues.push(`A placeholder regular expression must not match an empty string: ${source}`);
        continue;
      }
      expression.lastIndex = 0;
      patterns.push(expression);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`Invalid placeholder regular expression ${source}: ${message}`);
    }
  }
  return { patterns, issues };
}

export function maskPlaceholders(text: string, patterns: readonly RegExp[]): MaskedSql {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match[0].length > 0) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }

  const mergedRanges = mergeRanges(ranges);
  const characters = text.split('');
  for (const range of mergedRanges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (characters[index] !== '\r' && characters[index] !== '\n') {
        characters[index] = 'x';
      }
    }
  }
  return { text: characters.join(''), ranges: mergedRanges };
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const result: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
