import { LLMError } from '../../types/errors.js';

/**
 * Parses a Server-Sent-Events stream of bytes or text into each frame's
 * JSON `data:` payload, in order, over any transport. Multi-line data is
 * joined with `\n`, comment-only frames yield `SSE_PING`, other fields are
 * ignored, and a `[DONE]` frame ends iteration. `\r\n` and bare `\r` count
 * as line endings, including a `\r\n` split across two chunks. Malformed
 * JSON throws `LLMError('parse')`.
 */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<unknown> {
  // `fatal: true` makes invalid UTF-8 throw instead of silently decoding
  // to U+FFFD replacement characters, which could otherwise land inside a
  // JSON string and either corrupt it unnoticeably or, worse, still parse
  // as syntactically valid JSON with silently-wrong content.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const framer = createFrameSplitter();

  for await (const chunk of source) {
    let text: string;

    try {
      text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    } catch (cause) {
      throw new LLMError('Invalid UTF-8 in SSE stream', 'parse', { cause });
    }

    for (const frame of framer.push(text)) {
      const event = parseSseFrame(frame);

      if (event === DONE) return;
      if (event !== NO_DATA) yield event;
    }
  }

  // Flush any bytes TextDecoder held back mid-decode, so a truncated
  // multi-byte char surfaces as a parse error instead of silently
  // vanishing (and possibly leaving behind valid-looking, wrong JSON).
  let tail: string;

  try {
    tail = decoder.decode();
  } catch (cause) {
    throw new LLMError('Invalid UTF-8 in SSE stream', 'parse', { cause });
  }

  const { frames, trailing } = framer.end(tail);

  for (const frame of frames) {
    const event = parseSseFrame(frame);

    if (event === DONE) return;
    if (event !== NO_DATA) yield event;
  }

  // Flush a final frame that arrived without a trailing blank line: some
  // servers close the connection right after the last `data:` line instead
  // of sending one more `\n\n` first.
  const rest = trailing.trim();

  if (rest) {
    const event = parseSseFrame(rest);

    if (event !== DONE && event !== NO_DATA) yield event;
  }
}

/**
 * Splits normalized SSE text into complete frames. Only newly arrived text
 * is normalized and scanned, and an incomplete frame is kept as a list of
 * pieces joined once when it completes, so a large frame spread over many
 * transport chunks costs linear time instead of rescanning the whole
 * buffer on every chunk.
 */
function createFrameSplitter() {
  let parts: string[] = [];
  // Whether the incomplete frame ends in `\n`, so a `\n` at the start of
  // the next text completes a blank line boundary across the two pieces.
  let endsWithLf = false;
  // A trailing `\r` is held back until more text arrives, since it may be
  // the first half of a `\r\n` pair split across two transport chunks.
  let heldCr = false;

  function split(raw: string): string[] {
    let text = heldCr ? `\r${raw}` : raw;

    heldCr = text.endsWith('\r');
    if (heldCr) text = text.slice(0, -1);

    text = text.replace(/\r\n?/g, '\n');

    const frames: string[] = [];
    let pos = 0;

    if (endsWithLf && text.startsWith('\n')) {
      frames.push(parts.join('').slice(0, -1));
      parts = [];
      endsWithLf = false;
      pos = 1;
    }

    let boundary = text.indexOf('\n\n', pos);

    while (boundary !== -1) {
      parts.push(text.slice(pos, boundary));
      frames.push(parts.join(''));
      parts = [];
      pos = boundary + 2;
      boundary = text.indexOf('\n\n', pos);
    }

    const rest = text.slice(pos);

    if (rest) {
      parts.push(rest);
      endsWithLf = rest.endsWith('\n');
    } else if (pos > 0) {
      // A boundary emptied `parts`, so nothing is left to end in `\n`.
      endsWithLf = false;
    }

    return frames;
  }

  return {
    push: split,
    /** The stream ended, so a held `\r` can only be a bare CR line ending now. */
    end(tail: string): { frames: string[]; trailing: string } {
      const frames = split(tail);

      if (heldCr) {
        heldCr = false;
        frames.push(...split('\n'));
      }

      return { frames, trailing: parts.join('') };
    },
  };
}

const DONE = Symbol('sse-stream-done');
const NO_DATA = Symbol('sse-frame-no-data');

/**
 * Yielded for a comment-only frame, the SSE keep-alive ping, so a consumer
 * can tell "still alive" apart from an empty frame.
 */
export const SSE_PING = Symbol('sse-frame-ping');

/** Extracts and JSON-parses the `data:` payload of one SSE frame (the text between two blank lines). */
function parseSseFrame(frame: string): unknown {
  const dataLines: string[] = [];
  let sawComment = false;

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) {
      sawComment = true; // comment line, also used as a keep-alive ping
      continue;
    }
    if (!line.startsWith('data:')) continue; // ignore event:/id:/retry:/blank lines

    // A single space after the colon is stripped per the SSE spec; further
    // leading whitespace is preserved as part of the payload.
    dataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
  }

  if (!dataLines.length) return sawComment ? SSE_PING : NO_DATA;

  const data = dataLines.join('\n');

  if (data === '[DONE]') return DONE;

  try {
    return JSON.parse(data);
  } catch (cause) {
    throw new LLMError(`Invalid JSON in SSE frame: ${data.slice(0, 200)}`, 'parse', {
      cause,
      code: 'stream_frame_invalid',
    });
  }
}
