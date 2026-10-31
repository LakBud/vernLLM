import { describe, expect, it } from 'vitest';

import { mergeSpans, splitText } from '../../src/guardrail/hosted/chunks.js';
import { createLookup } from '../../src/guardrail/hosted/lookup.js';
import { createMemo, segmentKey } from '../../src/guardrail/hosted/memo.js';
import { locate, matchSpans } from '../../src/guardrail/hosted/spans.js';

// The shared part of a hosted detector, in the cases a detector's own tests don't reach.

describe('splitText', () => {
  it('keeps a text that fits as one chunk, and overlaps the rest', () => {
    expect(splitText('abcd', 4, 1)).toEqual([{ text: 'abcd', offset: 0 }]);
    expect(splitText('abcdefghij', 4, 1)).toEqual([
      { text: 'abcd', offset: 0 },
      { text: 'defg', offset: 3 },
      { text: 'ghij', offset: 6 },
    ]);
  });

  it('never cuts a surrogate pair, at the end or the start of a chunk', () => {
    expect(splitText('abc😀def', 4, 0)).toEqual([
      { text: 'abc', offset: 0 },
      { text: '😀de', offset: 3 },
      { text: 'f', offset: 7 },
    ]);
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
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      if (at > 0) expect(chunk.offset).toBeGreaterThan(chunks[at - 1]!.offset);
    }
  });
});

describe('mergeSpans', () => {
  it('shifts offsets by the chunk offset, keeps what two chunks both found once, and leaves a whole text finding as it is', () => {
    expect(
      mergeSpans([
        { offset: 0, spans: [{ label: 'a', start: 8, end: 10 }, { label: 't' }] },
        { offset: 6, spans: [{ label: 'a', start: 2, end: 4 }, { label: 't' }] },
      ]),
    ).toEqual([{ label: 'a', start: 8, end: 10 }, { label: 't' }]);
  });
});

describe('locate and matchSpans', () => {
  it('finds every occurrence in order, reads special characters as text, and skips an empty string', () => {
    expect(locate('a.b a+b a.b', ['', 'a.b'])).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it('keeps places that overlap, the shorter first at the same start', () => {
    expect(locate('abcd', ['abc', 'ab', 'bcd'])).toEqual([
      { start: 0, end: 2 },
      { start: 0, end: 3 },
      { start: 1, end: 4 },
    ]);
  });

  it('can require a whole word', () => {
    expect(locate('cat concatenate _cat cat9 cat', ['cat'], true)).toEqual([
      { start: 0, end: 3 },
      { start: 26, end: 29 },
    ]);
  });

  it('gives a finding without a span for a match it cannot find', () => {
    expect(matchSpans('call 555', 'pii.PHONE', ['555', '777'])).toEqual([
      { label: 'pii.PHONE', start: 5, end: 8 },
      { label: 'pii.PHONE' },
    ]);
  });
});

describe('the cache', () => {
  it('is off for a maximum of 0, and drops the least recently used past its maximum', () => {
    expect(createMemo(0)).toBeUndefined();

    const memo = createMemo(2)!;
    memo.set('a', []);
    memo.set('b', []);
    memo.get('a');
    memo.set('c', []);

    expect(memo.get('b')).toBeUndefined();
    expect(memo.get('a')).toBeDefined();
    expect(memo.get('c')).toBeDefined();
  });

  it('keys a text by its source and text, and never holds the text', async () => {
    const user = await segmentKey('user', 'secret text');

    expect(user).toBe(await segmentKey('user', 'secret text'));
    expect(user).not.toBe(await segmentKey('output', 'secret text'));
    expect(user).not.toContain('secret');
  });
});

describe('createLookup', () => {
  const signal = new AbortController().signal;

  it('answers a text that appears twice in one call from one request', async () => {
    const asked: string[][] = [];
    const lookup = createLookup({
      name: 'test',
      concurrency: 1,
      cache: { max: 10 },
      analyze: async (segments) => {
        asked.push(segments.map((segment) => segment.text));
        return segments.map(() => [{ label: 'kind.a' }]);
      },
    });

    const found = await lookup(
      [
        { text: 'x', source: 'user' },
        { text: 'x', source: 'user' },
      ],
      signal,
    );

    expect(found).toEqual([[{ label: 'kind.a' }], [{ label: 'kind.a' }]]);
    expect(asked).toEqual([['x']]);
  });

  it('refuses an answer for the wrong number of texts, rather than guess whose is whose', async () => {
    const lookup = createLookup({
      name: 'test',
      concurrency: 1,
      cache: false,
      analyze: async () => [],
    });

    await expect(lookup([{ text: 'x', source: 'user' }], signal)).rejects.toThrow(
      'test: the provider answered for the wrong number of texts',
    );
  });
});
