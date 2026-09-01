export type ParserGapDialect =
  | 'flink'
  | 'generic'
  | 'hive'
  | 'impala'
  | 'mysql'
  | 'postgres'
  | 'postgresql'
  | 'spark'
  | 'trino';

interface GapToken {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly upper: string;
  readonly kind: 'number' | 'string' | 'symbol' | 'word';
  readonly depth: number;
  readonly parentOpen?: number;
}

interface HandlerRange {
  readonly startToken: number;
  readonly endToken: number;
  readonly target: 'EMPTY' | 'ERROR';
  readonly group: string;
}

interface TokenRange {
  readonly startToken: number;
  readonly endToken: number;
}

export interface SqlParserGapNormalization {
  readonly text: string;
  readonly hasMalformedSyntax: boolean;
}

const JSON_FUNCTIONS = new Set([
  'JSON_ARRAY',
  'JSON_ARRAYAGG',
  'JSON_OBJECT',
  'JSON_OBJECTAGG',
  'JSON_QUERY',
  'JSON_TABLE',
  'JSON_VALUE',
]);

const NULL_TREATMENT_FUNCTIONS = new Set([
  'JSON_ARRAY',
  'JSON_ARRAYAGG',
  'JSON_OBJECT',
  'JSON_OBJECTAGG',
]);

const STANDARD_SQL_JSON_DIALECTS = new Set<ParserGapDialect>([
  'flink',
  'postgres',
  'postgresql',
  'trino',
]);

const RETURNING_BOUNDARIES = new Set([
  'ABSENT',
  'DEFAULT',
  'EMPTY',
  'ERROR',
  'FORMAT',
  'NULL',
  'ON',
  'RETURNING',
]);

/**
 * Masks syntax that the pinned parsers cannot model while retaining source length and line breaks.
 * Only complete SQL/JSON modifiers are hidden; malformed or out-of-order modifiers remain visible
 * to the grammar validator.
 */
export function maskSqlParserGaps(text: string, dialect: ParserGapDialect): string {
  return normalizeSqlParserGaps(text, dialect).text;
}

export function normalizeSqlParserGaps(
  text: string,
  dialect: ParserGapDialect,
): SqlParserGapNormalization {
  const { tokens, matchingParens } = scanGapTokens(text);
  const characters = text.split('');
  let hasMalformedSyntax = false;

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const name = tokens[index];
    const open = tokens[index + 1];
    if (!name || !open || name.kind !== 'word' || !JSON_FUNCTIONS.has(name.upper) || open.text !== '('
      || tokens[index - 1]?.text === '.') continue;
    const closeIndex = matchingParens.get(index + 1);
    if (closeIndex === undefined) continue;
    hasMalformedSyntax = maskJsonFunctionGaps(
      characters,
      tokens,
      matchingParens,
      name.upper,
      index + 1,
      closeIndex,
      dialect,
    ) || hasMalformedSyntax;
  }

  return { text: characters.join(''), hasMalformedSyntax };
}

function maskJsonFunctionGaps(
  characters: string[],
  tokens: readonly GapToken[],
  matchingParens: ReadonlyMap<number, number>,
  functionName: string,
  openIndex: number,
  closeIndex: number,
  dialect: ParserGapDialect,
): boolean {
  const directDepth = tokens[openIndex]!.depth + 1;
  let hasMalformedSyntax = false;

  if (!supportsJsonParserGap(functionName, dialect)) return false;

  if (dialect === 'postgres' || dialect === 'postgresql') {
    for (let index = openIndex + 1; index + 1 < closeIndex; index += 1) {
      const token = tokens[index];
      const next = tokens[index + 1];
      if ((token?.upper === 'JSON' || token?.upper === 'JSONB') && next?.kind === 'string') {
        maskTokenRange(characters, tokens, index, index);
      }
    }
  }

  const returningRanges = findReturningRanges(tokens, matchingParens, openIndex + 1, closeIndex, directDepth);
  const returningStarts = returningRanges.filter((range) => tokens[range.startToken]?.upper === 'RETURNING');
  const returningTokens = tokenIndexes(tokens, openIndex + 1, closeIndex, directDepth, 'RETURNING');
  let modifiersInValidOrder = returningStarts.length <= 1;
  if (returningStarts.length !== returningTokens.length || returningStarts.length > 1) {
    hasMalformedSyntax = true;
  }
  const returningStart = returningStarts[0]?.startToken;
  if (returningStart !== undefined) {
    const formats = tokenIndexes(tokens, returningStart + 1, closeIndex, directDepth, 'FORMAT');
    const maskedFormats = new Set(returningRanges
      .filter((range) => tokens[range.startToken]?.upper === 'FORMAT')
      .map((range) => range.startToken));
    if (formats.some((index) => !maskedFormats.has(index))) hasMalformedSyntax = true;
  }

  if (NULL_TREATMENT_FUNCTIONS.has(functionName)) {
    const nullTreatments: TokenRange[] = [];
    for (let index = openIndex + 1; index + 2 < closeIndex; index += 1) {
      if (tokens[index]?.depth !== directDepth) continue;
      if ((tokens[index]!.upper === 'NULL' || tokens[index]!.upper === 'ABSENT')
        && tokens[index + 1]?.upper === 'ON'
        && tokens[index + 2]?.upper === 'NULL') {
        nullTreatments.push({ startToken: index, endToken: index + 2 });
        index += 2;
      }
    }
    if (nullTreatments.length > 1
      || (returningStarts[0] && nullTreatments.some((range) => range.startToken > returningStarts[0]!.startToken))) {
      modifiersInValidOrder = false;
      hasMalformedSyntax = true;
    } else {
      for (const range of nullTreatments) {
        maskTokenRange(characters, tokens, range.startToken, range.endToken);
      }
    }
    if (hasIncompleteNullTreatments(tokens, openIndex + 1, closeIndex, directDepth, nullTreatments)) {
      hasMalformedSyntax = true;
    }
  }

  if (functionName === 'JSON_VALUE' || functionName === 'JSON_QUERY') {
    const handlers = findHandlerRanges(tokens, matchingParens, openIndex + 1, closeIndex, directDepth, false);
    if (returningStarts[0] && handlers.some((handler) => handler.startToken < returningStarts[0]!.startToken)) {
      modifiersInValidOrder = false;
      hasMalformedSyntax = true;
    } else {
      if (!maskOrderedHandlers(characters, tokens, handlers)) hasMalformedSyntax = true;
    }
    const modifierStart = jsonPathModifierStart(tokens, matchingParens, openIndex, closeIndex, directDepth);
    if (hasIncompleteHandlers(tokens, modifierStart, closeIndex, directDepth, handlers)) {
      hasMalformedSyntax = true;
    }
  } else if (functionName === 'JSON_TABLE') {
    const handlers = findHandlerRanges(tokens, matchingParens, openIndex + 1, closeIndex, undefined, true);
    if (!maskOrderedHandlers(characters, tokens, handlers)) hasMalformedSyntax = true;
    if (hasIncompleteHandlers(tokens, openIndex + 1, closeIndex, undefined, handlers)) {
      hasMalformedSyntax = true;
    }
    for (let index = openIndex + 1; index + 1 < closeIndex; index += 1) {
      if (tokens[index]?.upper === 'EXISTS' && tokens[index + 1]?.upper === 'PATH') {
        maskTokenRange(characters, tokens, index, index);
      }
    }
  }

  if (modifiersInValidOrder) {
    for (const range of returningRanges) {
      maskTokenRange(characters, tokens, range.startToken, range.endToken);
    }
  }
  return hasMalformedSyntax;
}

function supportsJsonParserGap(functionName: string, dialect: ParserGapDialect): boolean {
  if (functionName === 'JSON_TABLE') return dialect === 'mysql';
  if (functionName === 'JSON_VALUE') return dialect === 'mysql' || STANDARD_SQL_JSON_DIALECTS.has(dialect);
  if (functionName === 'JSON_QUERY') return STANDARD_SQL_JSON_DIALECTS.has(dialect);
  return STANDARD_SQL_JSON_DIALECTS.has(dialect);
}

function findReturningRanges(
  tokens: readonly GapToken[],
  matchingParens: ReadonlyMap<number, number>,
  startIndex: number,
  endIndex: number,
  depth: number,
): TokenRange[] {
  const ranges: TokenRange[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index]?.depth !== depth || tokens[index]?.upper !== 'RETURNING') continue;
    const typeEnd = consumeReturningType(tokens, matchingParens, index + 1, endIndex, depth);
    if (typeEnd === undefined) continue;
    ranges.push({ startToken: index, endToken: typeEnd });

    let cursor = typeEnd + 1;
    if (tokens[cursor]?.depth === depth && tokens[cursor]?.upper === 'FORMAT'
      && tokens[cursor + 1]?.upper === 'JSON') {
      let formatEnd = cursor + 1;
      if (tokens[formatEnd + 1]?.upper === 'ENCODING'
        && /^(?:UTF8|UTF16|UTF32)$/u.test(tokens[formatEnd + 2]?.upper ?? '')) {
        formatEnd += 2;
      }
      ranges.push({ startToken: cursor, endToken: formatEnd });
      cursor = formatEnd + 1;
    }
    index = cursor - 1;
  }
  return ranges;
}

function consumeReturningType(
  tokens: readonly GapToken[],
  matchingParens: ReadonlyMap<number, number>,
  startIndex: number,
  endIndex: number,
  depth: number,
): number | undefined {
  const first = tokens[startIndex];
  if (!first || first.depth !== depth || first.kind !== 'word' || RETURNING_BOUNDARIES.has(first.upper)) {
    return undefined;
  }
  let end = startIndex;

  while (tokens[end + 1]?.text === '.' && tokens[end + 2]?.kind === 'word'
    && tokens[end + 1]?.depth === depth && tokens[end + 2]?.depth === depth) {
    end += 2;
  }

  if ((first.upper === 'DOUBLE' && tokens[end + 1]?.upper === 'PRECISION')
    || (first.upper === 'CHARACTER' && tokens[end + 1]?.upper === 'VARYING')
    || ((first.upper === 'SIGNED' || first.upper === 'UNSIGNED') && tokens[end + 1]?.upper === 'INTEGER')) {
    end += 1;
  }

  if (tokens[end + 1]?.text === '(' && tokens[end + 1]?.depth === depth) {
    const parameterEnd = matchingParens.get(end + 1);
    if (parameterEnd === undefined || parameterEnd >= endIndex) return undefined;
    end = parameterEnd;
  }

  if ((first.upper === 'TIME' || first.upper === 'TIMESTAMP')
    && (tokens[end + 1]?.upper === 'WITH' || tokens[end + 1]?.upper === 'WITHOUT')
    && tokens[end + 2]?.upper === 'TIME' && tokens[end + 3]?.upper === 'ZONE') {
    end += 3;
  }
  return end;
}

function findHandlerRanges(
  tokens: readonly GapToken[],
  matchingParens: ReadonlyMap<number, number>,
  startIndex: number,
  endIndex: number,
  depth: number | undefined,
  groupByColumn: boolean,
): HandlerRange[] {
  const handlers: HandlerRange[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (!token || (depth !== undefined && token.depth !== depth)) continue;
    const range = consumeHandler(tokens, matchingParens, index, endIndex);
    if (!range) continue;
    handlers.push({
      ...range,
      group: groupByColumn ? handlerColumnGroup(tokens, index, startIndex) : 'function',
    });
    index = range.endToken;
  }
  return handlers;
}

function consumeHandler(
  tokens: readonly GapToken[],
  matchingParens: ReadonlyMap<number, number>,
  startIndex: number,
  endIndex: number,
): Omit<HandlerRange, 'group'> | undefined {
  const start = tokens[startIndex];
  if (!start) return undefined;
  let onIndex: number;

  if (start.upper === 'ERROR' || start.upper === 'NULL') {
    onIndex = startIndex + 1;
  } else if (start.upper === 'EMPTY'
    && (tokens[startIndex + 1]?.upper === 'ARRAY' || tokens[startIndex + 1]?.upper === 'OBJECT')) {
    onIndex = startIndex + 2;
  } else if (start.upper === 'DEFAULT') {
    const expressionEnd = consumeDefaultExpression(tokens, matchingParens, startIndex + 1, endIndex, start.depth);
    if (expressionEnd === undefined) return undefined;
    onIndex = expressionEnd + 1;
  } else {
    return undefined;
  }

  if (tokens[onIndex]?.upper !== 'ON' || tokens[onIndex]?.depth !== start.depth) return undefined;
  const target = tokens[onIndex + 1]?.upper;
  if (target !== 'EMPTY' && target !== 'ERROR') return undefined;
  return { startToken: startIndex, endToken: onIndex + 1, target };
}

function consumeDefaultExpression(
  tokens: readonly GapToken[],
  matchingParens: ReadonlyMap<number, number>,
  startIndex: number,
  endIndex: number,
  depth: number,
): number | undefined {
  const first = tokens[startIndex];
  if (!first || first.depth !== depth) return undefined;
  if ((first.text === '+' || first.text === '-') && tokens[startIndex + 1]?.kind === 'number') {
    return startIndex + 1;
  }
  if (first.text === '(') {
    const close = matchingParens.get(startIndex);
    return close !== undefined && close < endIndex ? close : undefined;
  }
  if (first.kind === 'string' || first.kind === 'number') return startIndex;
  if (first.kind === 'word' && !['DEFAULT', 'EMPTY', 'ERROR', 'ON'].includes(first.upper)) {
    if (tokens[startIndex + 1]?.text === '(') {
      const close = matchingParens.get(startIndex + 1);
      return close !== undefined && close < endIndex ? close : undefined;
    }
    return startIndex;
  }
  return undefined;
}

function maskOrderedHandlers(
  characters: string[],
  tokens: readonly GapToken[],
  handlers: readonly HandlerRange[],
): boolean {
  const groups = new Map<string, HandlerRange[]>();
  let valid = true;
  for (const handler of handlers) {
    const group = groups.get(handler.group) ?? [];
    group.push(handler);
    groups.set(handler.group, group);
  }
  for (const group of groups.values()) {
    const targets = group.map((handler) => handler.target);
    const validOrder = new Set(targets).size === targets.length
      && targets.every((target, index) => index === 0 || target !== 'EMPTY' || targets[index - 1] !== 'ERROR');
    if (!validOrder) {
      valid = false;
      continue;
    }
    for (const handler of group) {
      maskTokenRange(characters, tokens, handler.startToken, handler.endToken);
    }
  }
  return valid;
}

function hasIncompleteHandlers(
  tokens: readonly GapToken[],
  startIndex: number,
  endIndex: number,
  depth: number | undefined,
  handlers: readonly HandlerRange[],
): boolean {
  const covered = new Set(handlers.flatMap((handler) => (
    Array.from({ length: handler.endToken - handler.startToken + 1 }, (_, offset) => handler.startToken + offset)
  )));
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (!token || covered.has(index) || (depth !== undefined && token.depth !== depth)) continue;
    if (token.upper === 'DEFAULT' || token.upper === 'ON') return true;
    if ((token.upper === 'ERROR' || token.upper === 'NULL') && tokens[index + 1]?.upper === 'ON') return true;
    if (token.upper === 'EMPTY'
      && (tokens[index + 1]?.upper === 'ARRAY' || tokens[index + 1]?.upper === 'OBJECT')) return true;
  }
  return false;
}

function hasIncompleteNullTreatments(
  tokens: readonly GapToken[],
  startIndex: number,
  endIndex: number,
  depth: number,
  treatments: readonly TokenRange[],
): boolean {
  const covered = new Set(treatments.flatMap((treatment) => (
    Array.from({ length: treatment.endToken - treatment.startToken + 1 }, (_, offset) => treatment.startToken + offset)
  )));
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (!token || token.depth !== depth || covered.has(index)) continue;
    if (token.upper === 'ABSENT' || (token.upper === 'ON' && tokens[index + 1]?.upper === 'NULL')) return true;
  }
  return false;
}

function jsonPathModifierStart(
  tokens: readonly GapToken[],
  matchingParens: ReadonlyMap<number, number>,
  openIndex: number,
  closeIndex: number,
  depth: number,
): number {
  const comma = findToken(tokens, openIndex + 1, closeIndex, depth, ',');
  if (comma === undefined) return openIndex + 1;
  const pathStart = comma + 1;
  if (tokens[pathStart]?.text === '(') return (matchingParens.get(pathStart) ?? pathStart) + 1;
  if (tokens[pathStart]?.kind === 'word' && tokens[pathStart + 1]?.text === '(') {
    return (matchingParens.get(pathStart + 1) ?? pathStart) + 1;
  }
  return pathStart + 1;
}

function tokenIndexes(
  tokens: readonly GapToken[],
  startIndex: number,
  endIndex: number,
  depth: number,
  upper: string,
): number[] {
  const indexes: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index]?.depth === depth && tokens[index]?.upper === upper) indexes.push(index);
  }
  return indexes;
}

function handlerColumnGroup(tokens: readonly GapToken[], tokenIndex: number, lowerBound: number): string {
  const token = tokens[tokenIndex]!;
  let segment = 0;
  for (let index = tokenIndex - 1; index >= lowerBound; index -= 1) {
    const candidate = tokens[index]!;
    if (candidate.parentOpen !== token.parentOpen) continue;
    if (candidate.text === ',') segment += 1;
  }
  return `${token.parentOpen ?? -1}:${segment}`;
}

function findToken(
  tokens: readonly GapToken[],
  startIndex: number,
  endIndex: number,
  depth: number,
  text: string,
): number | undefined {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index]?.depth === depth && tokens[index]?.text === text) return index;
  }
  return undefined;
}

function maskTokenRange(
  characters: string[],
  tokens: readonly GapToken[],
  startToken: number,
  endToken: number,
): void {
  const start = tokens[startToken]?.start;
  const end = tokens[endToken]?.end;
  if (start === undefined || end === undefined) return;
  for (let index = start; index < end; index += 1) {
    if (!/\s/u.test(characters[index] ?? '')) characters[index] = ' ';
  }
}

function scanGapTokens(text: string): {
  tokens: GapToken[];
  matchingParens: Map<number, number>;
} {
  const tokens: GapToken[] = [];
  const matchingParens = new Map<number, number>();
  const openParens: number[] = [];
  let depth = 0;
  let index = 0;

  const append = (start: number, end: number, kind: GapToken['kind']): void => {
    const value = text.slice(start, end);
    tokens.push({
      start,
      end,
      text: value,
      upper: value.toLocaleUpperCase(),
      kind,
      depth,
      parentOpen: openParens.at(-1),
    });
  };

  while (index < text.length) {
    const character = text[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && text[index + 1] === '-') {
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, text.length);
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === quote) {
          if (text[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        if (text[index] === '\\' && index + 1 < text.length) index += 1;
        index += 1;
      }
      append(start, index, 'string');
      continue;
    }
    if (/[\p{L}_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[\p{L}\p{N}_$]/u.test(text[index]!)) index += 1;
      append(start, index, 'word');
      continue;
    }
    if (/\d/u.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[\d_]/u.test(text[index]!)) index += 1;
      if (text[index] === '.' && /\d/u.test(text[index + 1] ?? '')) {
        index += 1;
        while (index < text.length && /[\d_]/u.test(text[index]!)) index += 1;
      }
      if ((text[index] === 'e' || text[index] === 'E') && /[\d+-]/u.test(text[index + 1] ?? '')) {
        index += 1;
        if (text[index] === '+' || text[index] === '-') index += 1;
        while (index < text.length && /[\d_]/u.test(text[index]!)) index += 1;
      }
      append(start, index, 'number');
      continue;
    }
    if (character === ')') {
      depth = Math.max(depth - 1, 0);
      const start = index;
      append(start, start + 1, 'symbol');
      const closeIndex = tokens.length - 1;
      const openIndex = openParens.pop();
      if (openIndex !== undefined) {
        matchingParens.set(openIndex, closeIndex);
        matchingParens.set(closeIndex, openIndex);
      }
      index += 1;
      continue;
    }
    const start = index;
    append(start, start + 1, 'symbol');
    if (character === '(') {
      openParens.push(tokens.length - 1);
      depth += 1;
    }
    index += 1;
  }

  return { tokens, matchingParens };
}
