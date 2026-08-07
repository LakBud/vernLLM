import { LLMError } from '../types/errors.js';

/**
 * Parses a Server-Sent-Events byte/text stream into the JSON payload of
 * each `data:` frame, in arrival order. Generic over transport: works with
 * anything that hands back progressively-arriving `Uint8Array` or `string`
 * chunks via async iteration — native `fetch`'s `response.body` (wrapped
 * to be iterable, see `webStreamToAsyncIterable` in `fetch.ts`), axios's
 * Node `Readable` (already async-iterable, no wrapping needed), etc — so
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
 * Simplification: `\r\n` line endings are normalized to `\n` before frame
 * splitting, so a bare `\r` (with no following `\n`) as a line terminator
 * — technically legal per the SSE spec, but not something any HTTP server
 * actually does in practice — is not handled. `\n` and `\r\n` (the two
 * line endings real servers use) both work.
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
    // the new text would miss that split pair.
    buffer = (buffer + text).replace(/\r\n/g, '\n');

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

  // Flushes any bytes `TextDecoder` held back mid-decode (its `{ stream:
  // true }` mode withholds a trailing, not-yet-complete multi-byte UTF-8
  // sequence in case another chunk arrives to complete it). Without this,
  // if the very last chunk of the whole source happened to end mid
  // multi-byte character, those held-back bytes are silently discarded
  // rather than surfacing as a replacement character — and if whatever
  // precedes them already happens to form syntactically valid JSON (e.g.
  // truncation lands right after a complete-looking number or string),
  // the result isn't a parse failure at all: it's a silently WRONG value
  // that looks legitimate. Flushing guarantees the truncation itself is
  // represented in the text, so it surfaces as a parse error instead of
  // quietly returning incomplete data as if it were the real thing.
  try {
    buffer += decoder.decode();
  } catch (cause) {
    throw new LLMError('Invalid UTF-8 in SSE stream', 'parse', undefined, undefined, cause);
  }

  // Flush a final frame that arrived without a trailing blank line — some
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

/** Extracts and JSON-parses the `data:` payload of one SSE frame (the text between two blank lines). */
function parseSseFrame(frame: string): unknown {
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment line, per the SSE spec
    if (!line.startsWith('data:')) continue; // ignore event:/id:/retry:/blank lines

    // A single space after the colon is stripped per the SSE spec; further
    // leading whitespace is preserved as part of the payload.
    dataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
  }

  if (!dataLines.length) return NO_DATA;

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
