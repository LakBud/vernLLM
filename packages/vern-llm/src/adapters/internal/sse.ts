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
  let buffer = '';

  for await (const chunk of source) {
    let text: string;

    try {
      text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    } catch (cause) {
      throw new LLMError('Invalid UTF-8 in SSE stream', 'parse', undefined, undefined, cause);
    }

    // Normalized against the whole buffer, not just the newly-arrived
    // chunk: a `\r\n` delimiter can straddle a chunk boundary (one chunk
    // ending in `\r`, the next starting with `\n`), and normalizing only
    // the new text would miss that split pair. A bare trailing `\r` (not
    // followed by anything yet) is left as-is for the same reason; it's
    // converted once either more text or end-of-stream resolves whether
    // it was standalone or the start of a split `\r\n`.
    buffer = (buffer + text).replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');

    let boundary = buffer.indexOf('\n\n');

    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);

      buffer = buffer.slice(boundary + 2);

      const event = parseSseFrame(frame);

      if (event === DONE) return;
      if (event !== NO_DATA) yield event;

      boundary = buffer.indexOf('\n\n');
    }
  }

  // Flush any bytes TextDecoder held back mid-decode, so a truncated
  // multi-byte char surfaces as a parse error instead of silently
  // vanishing (and possibly leaving behind valid-looking, wrong JSON).
  try {
    buffer += decoder.decode();
  } catch (cause) {
    throw new LLMError('Invalid UTF-8 in SSE stream', 'parse', undefined, undefined, cause);
  }

  // The stream has ended, so a trailing `\r` still held back above (it
  // could have been the start of a split `\r\n` pair) can only be a bare
  // CR line ending now. Normalize it and re-check for any frame boundary
  // it just completed.
  buffer = buffer.replace(/\r$/, '\n');

  let boundary = buffer.indexOf('\n\n');

  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary);

    buffer = buffer.slice(boundary + 2);

    const event = parseSseFrame(frame);

    if (event === DONE) return;
    if (event !== NO_DATA) yield event;

    boundary = buffer.indexOf('\n\n');
  }

  // Flush a final frame that arrived without a trailing blank line: some
  // servers close the connection right after the last `data:` line instead
  // of sending one more `\n\n` first.
  const trailing = buffer.trim();

  if (trailing) {
    const event = parseSseFrame(trailing);

    if (event !== DONE && event !== NO_DATA) yield event;
  }
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
    throw new LLMError(
      `Invalid JSON in SSE frame: ${data.slice(0, 200)}`,
      'parse',
      undefined,
      undefined,
      cause,
    );
  }
}
