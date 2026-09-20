import { describe, expect, it } from 'vitest';

import { TRUNCATION_MARKER, truncate } from '../../../../src/internal/content/truncate.utils.js';

describe('truncate', () => {
  it('returns text that fits untouched, with no marker', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello', 100)).toBe('hello');
    expect(truncate('hello', Number.POSITIVE_INFINITY)).toBe('hello');
    expect(truncate('', 0)).toBe('');
  });

  it('cuts to the limit and marks it', () => {
    expect(truncate('abcdef', 3)).toBe(`abc${TRUNCATION_MARKER}`);
  });

  it('leaves only the marker when nothing is allowed', () => {
    expect(truncate('abc', 0)).toBe(TRUNCATION_MARKER);
  });

  it('never splits a surrogate pair', () => {
    // Each emoji is two UTF-16 units, so a cut at 3 would land between the halves of the second.
    const cut = truncate('😀😀😀', 3);

    expect(cut).toBe(`😀${TRUNCATION_MARKER}`);
    expect(cut.startsWith('\ud83d\ude00')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut.replace(TRUNCATION_MARKER, ''))).toBe(
      false,
    );
  });

  it('keeps a whole pair when the cut falls after it', () => {
    expect(truncate('😀😀😀', 4)).toBe(`😀😀${TRUNCATION_MARKER}`);
  });

  it('drops the only pair when a limit of 1 would split it', () => {
    expect(truncate('😀', 0)).toBe(TRUNCATION_MARKER);
    expect(truncate('😀😀', 1)).toBe(TRUNCATION_MARKER);
  });
});
