import { LLMError } from '../../types/errors.js';

/**
 * Parses a Server-Sent-Events byte/text stream into the JSON payload of
 * each `data:` frame, in arrival order. Generic over transport: works with
 * anything that hands back progressively-arriving `Uint8Array` or `string`
 * chunks via async iteration: native `fetch`'s `response.body` (wrapped
 * to be iterable, see `webStreamToAsyncIterable` in `fetch.ts`), axios's
 * Node `Readable` (already async-iterable, no wrapping needed), etc, so
 * this framing layer doesn't care which transport produced the bytes.
 *
 * Follows the SSE spec's frame-delimiting rules closely enough for LLM
 * streaming responses: frames are separated by a blank line, each frame
 * may carry one or more `data:` lines (joined with `\n` per spec when
 * there's more than one), `:`-prefixed lines are comments and ignored, and
 * other SSE fields (`event:`, `id:`, `retry:`) are ignored since VernLLM
 * only needs the payload. A frame whose data is exactly `[DONE]` (the
 * sentinel several providers, notably OpenAI, send to mark stream end)
 * ends iteration without yielding it.
 *
 * Line endings: `\r\n` and bare `\r` (both legal per the SSE spec, alongside `\n`) are normalized
 * to `\n` before frame splitting. A `\r` at the very end of the currently-buffered text is left
 * alone until either more text arrives (in case it's the first half of a split `\r\n` pair) or the
 * stream ends, so a `\r\n` pair split across two transport chunks is never misread as two blank
 * lines.
 *
 * Malformed JSON in a frame throws `LLMError('parse')`, consistent with
 * how malformed JSON is handled elsewhere in VernLLM.
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
 * Sentinel yielded by `parseSseStream` for a comment-only frame (no
 * `data:` payload), the mechanism providers use for SSE keep-alive
 * pings. Exported so a consumer (e.g. `fromFetch`) can react to "still
 * alive" separately from a genuinely empty frame (`NO_DATA`, kept internal).
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
