import { findPlaceholderRanges, type PlaceholderRange } from './patterns';

export type JsonPlaceholderKind = 'string' | 'key' | 'value';

export interface JsonPlaceholderOccurrence {
  match: PlaceholderRange;
  token: PlaceholderRange;
  kind: JsonPlaceholderKind;
}

export interface JsonPlaceholderProjection {
  text: string;
  occurrences: readonly JsonPlaceholderOccurrence[];
}

export function projectJsonPlaceholders(
  text: string,
  patterns: readonly RegExp[],
): JsonPlaceholderProjection {
  const matches = findPlaceholderRanges(text, patterns);
  if (matches.length === 0) {
    return { text, occurrences: [] };
  }

  const stringRanges = findJsonStringRanges(text);
  const occurrences: JsonPlaceholderOccurrence[] = [];
  const externalTokens: PlaceholderRange[] = [];

  for (const match of matches) {
    const containingString = stringRanges.find((range) => contains(range, match));
    if (containingString) {
      occurrences.push({ match, token: match, kind: 'string' });
      continue;
    }
    externalTokens.push(expandBareToken(text, match));
  }

  const tokens = mergeRanges(externalTokens);
  const characters = text.split('');
  for (const token of tokens) {
    const kind: JsonPlaceholderKind = nextNonWhitespace(text, token.end) === ':' ? 'key' : 'value';
    const replacement = kind === 'key' && token.end - token.start >= 2 ? '""' : '0';
    for (let index = token.start; index < token.end; index += 1) {
      characters[index] = replacement[index - token.start] ?? ' ';
    }
    for (const match of matches.filter((candidate) => overlaps(candidate, token))) {
      occurrences.push({ match, token, kind });
    }
  }

  occurrences.sort((left, right) => left.match.start - right.match.start || left.match.end - right.match.end);
  return { text: characters.join(''), occurrences };
}

export function rangeContainsOffset(range: PlaceholderRange, offset: number): boolean {
  return offset >= range.start && offset <= range.end;
}

function findJsonStringRanges(text: string): PlaceholderRange[] {
  const ranges: PlaceholderRange[] = [];
  let start = -1;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === '"') {
        start = index;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      ranges.push({ start, end: index + 1 });
      start = -1;
    }
  }
  if (start >= 0) {
    ranges.push({ start, end: text.length });
  }
  return ranges;
}

function expandBareToken(text: string, range: PlaceholderRange): PlaceholderRange {
  let start = range.start;
  let end = range.end;
  while (start > 0 && !isJsonTokenBoundary(text[start - 1] ?? '')) {
    start -= 1;
  }
  while (end < text.length && !isJsonTokenBoundary(text[end] ?? '')) {
    end += 1;
  }
  return { start, end };
}

function isJsonTokenBoundary(character: string): boolean {
  return /\s/u.test(character) || '{}[],:'.includes(character);
}

function nextNonWhitespace(text: string, offset: number): string | undefined {
  for (let index = offset; index < text.length; index += 1) {
    if (!/\s/u.test(text[index] ?? '')) {
      return text[index];
    }
  }
  return undefined;
}

function contains(outer: PlaceholderRange, inner: PlaceholderRange): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function overlaps(left: PlaceholderRange, right: PlaceholderRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function mergeRanges(ranges: readonly PlaceholderRange[]): PlaceholderRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const result: PlaceholderRange[] = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}
