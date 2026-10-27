import { describe, expect, it } from 'vitest';

import { locate, matchSpans } from '../../../../src/internal/hosted/spans.js';

describe('locate', () => {
  it('finds every occurrence, in order', () => {
    expect(locate('a@x.io and a@x.io', ['a@x.io'])).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 },
    ]);
  });

  it('orders the places of several strings together, and drops repeats', () => {
    expect(locate('one two one', ['two', 'one', 'one'])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it('keeps places that overlap, longest first at the same start', () => {
    expect(locate('abcd', ['abc', 'ab', 'bcd'])).toEqual([
      { start: 0, end: 2 },
      { start: 0, end: 3 },
      { start: 1, end: 4 },
    ]);
  });

  it('ignores an empty string and reads special characters as text', () => {
    expect(locate('a.b a+b axb', ['', 'a.b'])).toEqual([{ start: 0, end: 3 }]);
    expect(locate('1 + (2)', ['+ (2)'])).toEqual([{ start: 2, end: 7 }]);
  });

  it('is case sensitive', () => {
    expect(locate('Cat cat', ['cat'])).toEqual([{ start: 4, end: 7 }]);
  });

  it('can require a whole word, the way keywords does', () => {
    expect(locate('cat concatenate cat. a-cat _cat cat9 ünicat', ['cat'], true)).toEqual([
      { start: 0, end: 3 },
      { start: 16, end: 19 },
      { start: 23, end: 26 },
    ]);
    expect(locate('concatenate', ['cat'], false)).toEqual([{ start: 3, end: 6 }]);
  });
});

describe('matchSpans', () => {
  it('gives a span for every place a match occurs', () => {
    expect(matchSpans('call 555 then 555', 'pii.PHONE', ['555'])).toEqual([
      { label: 'pii.PHONE', start: 5, end: 8 },
      { label: 'pii.PHONE', start: 14, end: 17 },
    ]);
  });

  it('gives a finding without a span for a match it cannot find, so redact fails closed', () => {
    expect(matchSpans('nothing here', 'pii.EMAIL', ['a@x.io'])).toEqual([{ label: 'pii.EMAIL' }]);
    expect(matchSpans('nothing here', 'pii.EMAIL', [''])).toEqual([{ label: 'pii.EMAIL' }]);
  });

  it('reads each distinct match once', () => {
    expect(matchSpans('a@x.io', 'e', ['a@x.io', 'a@x.io'])).toEqual([
      { label: 'e', start: 0, end: 6 },
    ]);
  });

  it('can require whole words', () => {
    expect(matchSpans('cat concatenate', 'word.custom', ['cat'], true)).toEqual([
      { label: 'word.custom', start: 0, end: 3 },
    ]);
  });

  it('is empty for no matches', () => {
    expect(matchSpans('text', 'x', [])).toEqual([]);
  });
});
