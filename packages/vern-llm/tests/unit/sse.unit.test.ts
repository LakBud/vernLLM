import { describe, it, expect } from 'vitest';

import { parseSseStream } from '../../src/internal/sse.js';

/** A source of string chunks, arriving one at a time, as an async iterable. */
function chunksOf(...parts: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
  };
}

/** A source of raw byte chunks, for exercising the `Uint8Array` branch. */
function byteChunksOf(...parts: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield encoder.encode(part);
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('parseSseStream', () => {
  it('parses a single well-formed frame', async () => {
    const events = await collect(parseSseStream(chunksOf('data: {"a":1}\n\n')));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('parses multiple frames arriving in one chunk', async () => {
    const events = await collect(
      parseSseStream(chunksOf('data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3}\n\n')),
    );
    expect(events).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('reassembles a frame split arbitrarily across multiple chunks', async () => {
    const events = await collect(
      parseSseStream(chunksOf('da', 'ta: {"a"', ':1}', '\n', '\n', 'data: {"a":2}\n\n')),
    );
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('works with Uint8Array chunks, not just strings', async () => {
    const events = await collect(parseSseStream(byteChunksOf('data: {"a":1}\n\n')));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('normalizes \r\n line endings', async () => {
    const events = await collect(parseSseStream(chunksOf('data: {"a":1}\r\n\r\n')));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('normalizes CRLF delimiters split across chunk boundaries', async () => {
    // Each frame's trailing \r\n\r\n boundary is split so the \r lands in
    // one chunk and the \n lands in the next, exercising whole-buffer
    // normalization (not per-chunk) needed to catch a delimiter that
    // straddles two transport chunks.
    const events = await collect(
      parseSseStream(chunksOf('data: {"a":1}\r', '\n\r', '\ndata: {"a":2}\r', '\n\r', '\n')),
    );
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('joins multiple data: lines within one frame with a newline, per the SSE spec', async () => {
    const events = await collect(parseSseStream(chunksOf('data: {"a":\ndata: 1}\n\n')));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('ignores comment lines (":"-prefixed)', async () => {
    const events = await collect(
      parseSseStream(chunksOf(': this is a keep-alive comment\ndata: {"a":1}\n\n')),
    );
    expect(events).toEqual([{ a: 1 }]);
  });

  it('ignores non-data SSE fields (event:, id:, retry:)', async () => {
    const events = await collect(
      parseSseStream(chunksOf('event: message\nid: 42\nretry: 3000\ndata: {"a":1}\n\n')),
    );
    expect(events).toEqual([{ a: 1 }]);
  });

  it('skips a frame with no data: line at all', async () => {
    const events = await collect(parseSseStream(chunksOf('event: ping\n\ndata: {"a":1}\n\n')));
    expect(events).toEqual([{ a: 1 }]);
  });

  it('stops iteration on a [DONE] sentinel frame without yielding it', async () => {
    const events = await collect(
      parseSseStream(chunksOf('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"a":2}\n\n')),
    );
    // The frame after [DONE] is never reached.
    expect(events).toEqual([{ a: 1 }]);
  });

  it('flushes a final frame that arrives without a trailing blank line', async () => {
    const events = await collect(parseSseStream(chunksOf('data: {"a":1}\n\ndata: {"a":2}')));
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('yields nothing for an empty source', async () => {
    const events = await collect(parseSseStream(chunksOf()));
    expect(events).toEqual([]);
  });

  it('throws LLMError(parse) on malformed JSON in a frame', async () => {
    await expect(
      collect(parseSseStream(chunksOf('data: {not valid json\n\n'))),
    ).rejects.toMatchObject({ type: 'parse' });
  });

  it('flushes a held-back incomplete trailing multi-byte character instead of silently dropping it and returning a wrong-but-valid value', async () => {
    // 'data: 1' followed by ONLY the first byte of '€' (0xE2 0x82 0xAC),
    // with nothing else — the source ends here, mid-character. Without
    // flushing TextDecoder's held-back byte, the trailing content is just
    // 'data: 1', which is syntactically valid JSON (the number `1`) — a
    // silently WRONG value, not merely a lost character, since the
    // truncation happens to land right after otherwise-complete JSON.
    // Flushing surfaces the held-back byte as a replacement character
    // ('\uFFFD'), making 'data: 1\uFFFD' correctly fail to parse instead.
    const prefix = new TextEncoder().encode('data: 1');
    const incompleteEuroFirstByte = new Uint8Array([0xe2]);

    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield prefix;
        yield incompleteEuroFirstByte;
      },
    };

    await expect(collect(parseSseStream(source))).rejects.toMatchObject({ type: 'parse' });
  });

  it('rejects invalid UTF-8 inside a JSON string with a wrapped parse error', async () => {
    // 0xff is never valid anywhere in a UTF-8 byte sequence. Embedded
    // inside what would otherwise be a well-formed JSON string, fatal
    // decoding must catch it and surface it as LLMError('parse') rather
    // than silently substituting a replacement character and letting a
    // corrupted string parse "successfully".
    const before = new TextEncoder().encode('data: {"a":"');
    const invalidByte = new Uint8Array([0xff]);
    const after = new TextEncoder().encode('"}\n\n');

    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield before;
        yield invalidByte;
        yield after;
      },
    };

    await expect(collect(parseSseStream(source))).rejects.toMatchObject({ type: 'parse' });
  });
});
