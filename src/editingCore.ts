export type SqlLexicalState = 'code' | 'singleQuote' | 'doubleQuote' | 'backtick' | 'lineComment' | 'blockComment';

export type SqlBracketCharacter = '(' | ')' | '[' | ']' | '{' | '}';

export interface SqlBracketInfo {
  character: SqlBracketCharacter;
  offset: number;
  pairOffset?: number;
  level: number;
  independentLevel: number;
  unexpected: boolean;
}

export interface SqlEditingStructure {
  brackets: readonly SqlBracketInfo[];
  states: readonly SqlLexicalState[];
}

const OPEN_TO_CLOSE = new Map<SqlBracketCharacter, SqlBracketCharacter>([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

const CLOSE_TO_OPEN = new Map<SqlBracketCharacter, SqlBracketCharacter>([
  [')', '('],
  [']', '['],
  ['}', '{'],
]);

interface PendingBracket {
  info: SqlBracketInfo;
  open: SqlBracketCharacter;
}

/**
 * Performs the small amount of lexical analysis needed by editor features.
 * Physical line endings have already been removed from embedded SQL by the
 * platform projection, while escaped JSON line endings remain real SQL lines.
 */
export function analyzeSqlEditingStructure(text: string): SqlEditingStructure {
  const states = new Array<SqlLexicalState>(text.length + 1);
  const brackets: SqlBracketInfo[] = [];
  const stack: PendingBracket[] = [];
  const typeDepth = new Map<SqlBracketCharacter, number>();
  let state: SqlLexicalState = 'code';

  for (let offset = 0; offset < text.length; offset += 1) {
    states[offset] = state;
    const character = text[offset] ?? '';
    const next = text[offset + 1] ?? '';

    if (state === 'lineComment') {
      if (character === '\n' || character === '\r') {
        state = 'code';
      }
      continue;
    }
    if (state === 'blockComment') {
      if (character === '*' && next === '/') {
        states[offset + 1] = state;
        offset += 1;
        state = 'code';
      }
      continue;
    }
    if (state !== 'code') {
      const quote = quoteForState(state);
      if (character === '\\') {
        if (offset + 1 < text.length) {
          states[offset + 1] = state;
          offset += 1;
        }
        continue;
      }
      if (character === quote && next === quote) {
        states[offset + 1] = state;
        offset += 1;
        continue;
      }
      if (character === quote) {
        state = 'code';
      }
      continue;
    }

    if (character === '-' && next === '-') {
      states[offset + 1] = state;
      offset += 1;
      state = 'lineComment';
      continue;
    }
    if (character === '/' && next === '*') {
      states[offset + 1] = state;
      offset += 1;
      state = 'blockComment';
      continue;
    }
    if (character === "'") {
      state = 'singleQuote';
      continue;
    }
    if (character === '"') {
      state = 'doubleQuote';
      continue;
    }
    if (character === '`') {
      state = 'backtick';
      continue;
    }
    if (!isSqlBracket(character)) {
      continue;
    }

    if (OPEN_TO_CLOSE.has(character)) {
      const independentLevel = typeDepth.get(character) ?? 0;
      const info: SqlBracketInfo = {
        character,
        offset,
        level: stack.length,
        independentLevel,
        unexpected: false,
      };
      brackets.push(info);
      stack.push({ info, open: character });
      typeDepth.set(character, independentLevel + 1);
      continue;
    }

    const expectedOpen = CLOSE_TO_OPEN.get(character);
    const pending = stack.at(-1);
    if (!expectedOpen || !pending || pending.open !== expectedOpen) {
      brackets.push({
        character,
        offset,
        level: stack.length,
        independentLevel: typeDepth.get(expectedOpen ?? '(') ?? 0,
        unexpected: true,
      });
      continue;
    }

    stack.pop();
    typeDepth.set(expectedOpen, Math.max(0, (typeDepth.get(expectedOpen) ?? 1) - 1));
    pending.info.pairOffset = offset;
    brackets.push({
      character,
      offset,
      pairOffset: pending.info.offset,
      level: pending.info.level,
      independentLevel: pending.info.independentLevel,
      unexpected: false,
    });
  }

  states[text.length] = state;
  for (const pending of stack) {
    pending.info.unexpected = true;
  }
  return { brackets, states };
}

export function lexicalStateAt(structure: SqlEditingStructure, offset: number): SqlLexicalState {
  const safeOffset = Math.min(Math.max(offset, 0), structure.states.length - 1);
  return structure.states[safeOffset] ?? 'code';
}

export function findBracketAt(
  structure: SqlEditingStructure,
  offset: number,
): SqlBracketInfo | undefined {
  return structure.brackets.find((bracket) => bracket.offset === offset - 1)
    ?? structure.brackets.find((bracket) => bracket.offset === offset);
}

function quoteForState(state: Exclude<SqlLexicalState, 'code' | 'lineComment' | 'blockComment'>): string {
  switch (state) {
    case 'singleQuote': return "'";
    case 'doubleQuote': return '"';
    case 'backtick': return '`';
  }
}

function isSqlBracket(character: string): character is SqlBracketCharacter {
  return OPEN_TO_CLOSE.has(character as SqlBracketCharacter) || CLOSE_TO_OPEN.has(character as SqlBracketCharacter);
}
