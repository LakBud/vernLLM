import { describe, expect, it } from 'vitest';

import { mergeSpans, splitText } from '../../../../src/internal/hosted/chunks.js';

describe('splitText', () => {
  it('keeps a text that fits as one chunk', () => {
    expect(splitText('abcd', 4, 1)).toEqual([{ text: 'abcd', offset: 0 }]);
    expect(splitText('', 4, 1)).toEqual([{ text: '', offset: 0 }]);
  });

  it('starts each chunk before the end of the last, by the overlap', () => {
    expect(splitText('abcdefghij', 4, 1)).toEqual([
      { text: 'abcd', offset: 0 },
      { text: 'defg', offset: 3 },
      { text: 'ghij', offset: 6 },
    ]);
  });

  it('makes chunks that only touch with no overlap', () => {
    expect(splitText('abcdefghij', 4, 0)).toEqual([
      { text: 'abcd', offset: 0 },
      { text: 'efgh', offset: 4 },
      { text: 'ij', offset: 8 },
    ]);
  });

  it('never cuts a surrogate pair at the end of a chunk', () => {
    expect(splitText('abc😀def', 4, 0)).toEqual([
      { text: 'abc', offset: 0 },
      { text: '😀de', offset: 3 },
      { text: 'f', offset: 7 },
    ]);
  });

  it('never starts a chunk in the middle of a surrogate pair', () => {
    expect(splitText('abcd😀efgh', 6, 1)).toEqual([
      { text: 'abcd😀', offset: 0 },
      { text: 'efgh', offset: 6 },
    ]);
  });

  it('keeps moving forward when the overlap is almost the whole chunk', () => {
    const text = 'abc😀def😀ghi';
    const chunks = splitText(text, 4, 3);

    expect(chunks.at(-1)!.offset + chunks.at(-1)!.text.length).toBe(text.length);
    for (const [at, chunk] of chunks.entries()) {
      expect(chunk.text.length).toBeLessThanOrEqual(4);
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      if (at > 0) expect(chunk.offset).toBeGreaterThan(chunks[at - 1]!.offset);
    }
  });
});

describe('mergeSpans', () => {
  it('shifts offsets back by the chunk offset', () => {
    expect(
      mergeSpans([
        { offset: 0, spans: [{ label: 'a', start: 1, end: 3 }] },
        { offset: 10, spans: [{ label: 'a', start: 1, end: 3 }] },
      ]),
    ).toEqual([
      { label: 'a', start: 1, end: 3 },
      { label: 'a', start: 11, end: 13 },
    ]);
  });

  it('keeps a finding from the overlap of two chunks once', () => {
    // The same value at 7 to 9 of the text, seen from a chunk at 0 and from one at 5.
    expect(
      mergeSpans([
        { offset: 0, spans: [{ label: 'a', start: 7, end: 9 }] },
        { offset: 5, spans: [{ label: 'a', start: 2, end: 4 }] },
      ]),
    ).toEqual([{ label: 'a', start: 7, end: 9 }]);
  });

  it('keeps a finding without offsets once per label', () => {
    expect(
      mergeSpans([
        { offset: 0, spans: [{ label: 'a' }, { label: 'b' }] },
        { offset: 5, spans: [{ label: 'a' }] },
      ]),
    ).toEqual([{ label: 'a' }, { label: 'b' }]);
  });

  it('is empty when nothing was found', () => {
    expect(mergeSpans([{ offset: 0, spans: [] }])).toEqual([]);
    expect(mergeSpans([])).toEqual([]);
  });
});
