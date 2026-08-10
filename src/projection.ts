export interface OriginalSpan {
  start: number;
  end: number;
}

export interface RemovedLineBreak extends OriginalSpan {
  projectedOffset: number;
}

/**
 * A platform-faithful view of a document. The AIOps platform removes physical
 * line endings before feeding the source to its JSON parser.
 */
export class PlatformProjection {
  readonly text: string;
  readonly removedLineBreaks: readonly RemovedLineBreak[];

  private readonly projectedCharactersToOriginal: readonly number[];
  private readonly originalBoundariesToProjected: readonly number[];

  constructor(readonly originalText: string) {
    const projectedCharacters: string[] = [];
    const characterMap: number[] = [];
    const boundaryMap = new Array<number>(originalText.length + 1);
    const removed: RemovedLineBreak[] = [];

    let originalOffset = 0;
    while (originalOffset < originalText.length) {
      boundaryMap[originalOffset] = projectedCharacters.length;
      const character = originalText[originalOffset];
      if (character === '\r' || character === '\n') {
        const lineBreakLength = character === '\r' && originalText[originalOffset + 1] === '\n' ? 2 : 1;
        removed.push({
          start: originalOffset,
          end: originalOffset + lineBreakLength,
          projectedOffset: projectedCharacters.length,
        });
        for (let index = originalOffset; index < originalOffset + lineBreakLength; index += 1) {
          boundaryMap[index] = projectedCharacters.length;
        }
        originalOffset += lineBreakLength;
        boundaryMap[originalOffset] = projectedCharacters.length;
        continue;
      }

      projectedCharacters.push(character ?? '');
      characterMap.push(originalOffset);
      originalOffset += 1;
      boundaryMap[originalOffset] = projectedCharacters.length;
    }

    boundaryMap[originalText.length] = projectedCharacters.length;
    this.text = projectedCharacters.join('');
    this.projectedCharactersToOriginal = characterMap;
    this.originalBoundariesToProjected = boundaryMap;
    this.removedLineBreaks = removed;
  }

  toProjectedOffset(originalOffset: number): number {
    const offset = clamp(originalOffset, 0, this.originalText.length);
    return this.originalBoundariesToProjected[offset] ?? this.text.length;
  }

  toOriginalOffset(projectedOffset: number, bias: 'start' | 'end' = 'start'): number {
    const offset = clamp(projectedOffset, 0, this.text.length);
    if (this.text.length === 0) {
      return bias === 'start' ? 0 : this.originalText.length;
    }
    if (offset === this.text.length) {
      return this.originalText.length;
    }
    if (bias === 'end' && offset > 0) {
      return (this.projectedCharactersToOriginal[offset - 1] ?? -1) + 1;
    }
    return this.projectedCharactersToOriginal[offset] ?? this.originalText.length;
  }

  mapProjectedRange(start: number, end: number): OriginalSpan {
    const safeStart = clamp(start, 0, this.text.length);
    const safeEnd = clamp(Math.max(start, end), safeStart, this.text.length);
    if (safeStart === safeEnd) {
      const original = this.toOriginalOffset(safeStart, 'start');
      return { start: original, end: original };
    }
    return {
      start: this.toOriginalOffset(safeStart, 'start'),
      end: this.toOriginalOffset(safeEnd, 'end'),
    };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
