import { describe, expect, it } from 'vitest';

import { PlatformProjection } from '../../src/projection';

describe('PlatformProjection', () => {
  it('removes LF, CRLF, and CR while preserving bidirectional offsets', () => {
    const projection = new PlatformProjection('a\r\nb\nc\rd');

    expect(projection.text).toBe('abcd');
    expect(projection.removedLineBreaks).toEqual([
      { start: 1, end: 3, projectedOffset: 1 },
      { start: 4, end: 5, projectedOffset: 2 },
      { start: 6, end: 7, projectedOffset: 3 },
    ]);
    expect(projection.toProjectedOffset(3)).toBe(1);
    expect(projection.toOriginalOffset(1, 'start')).toBe(3);
    expect(projection.mapProjectedRange(0, 2)).toEqual({ start: 0, end: 4 });
  });

  it('handles empty and newline-only documents', () => {
    expect(new PlatformProjection('').text).toBe('');
    const projection = new PlatformProjection('\r\n\n');
    expect(projection.text).toBe('');
    expect(projection.toProjectedOffset(3)).toBe(0);
  });
});
