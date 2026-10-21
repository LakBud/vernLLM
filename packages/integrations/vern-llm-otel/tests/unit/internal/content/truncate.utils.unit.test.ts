import { describe, expect, it } from 'vitest';

import { TRUNCATION_MARKER, truncate } from '../../../../src/internal/content/truncate.utils.js';

const M = TRUNCATION_MARKER.length;

describe('truncate', () => {
  it('returns text that fits untouched, with no marker', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello', 100)).toBe('hello');
    expect(truncate('hello', Number.POSITIVE_INFINITY)).toBe('hello');
    expect(truncate('', 0)).toBe('');
  });

  it('keeps the marker inside the limit', () => {
    const cut = truncate('abcdefghijklmnopqrstuvwxyz', M + 3);

    expect(cut).toBe(`abc${TRUNCATION_MARKER}`);
    expect(cut!.length).toBe(M + 3);
  });

  it('leaves the piece out when nothing fits next to the marker', () => {
    expect(truncate('abcdefghijklmnopqrstuvwxyz', 0)).toBeUndefined();
    expect(truncate('abcdefghijklmnopqrstuvwxyz', M)).toBeUndefined();
  });

  it('never splits a surrogate pair', () => {
    // Each emoji is two UTF-16 units, so a cut at 3 would land between the halves of the second.
    const cut = truncate('😀😀😀😀😀😀😀😀😀😀', M + 3);

    expect(cut).toBe(`😀${TRUNCATION_MARKER}`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut!.replace(TRUNCATION_MARKER, ''))).toBe(
      false,
    );
  });

  it('keeps a whole pair when the cut falls after it', () => {
    expect(truncate('😀😀😀😀😀😀😀😀😀😀', M + 4)).toBe(`😀😀${TRUNCATION_MARKER}`);
  });

  it('leaves the piece out when a limit of one unit would split the only pair', () => {
    expect(truncate('😀😀😀😀😀😀😀😀😀😀', M + 1)).toBeUndefined();
  });
});
