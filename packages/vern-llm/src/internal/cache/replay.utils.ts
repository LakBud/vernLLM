import type { StreamChunk } from '../../types/stream.js';
import type { CallWithToolsResult } from '../../types/tools.js';

/**
 * Converts an already-known cache value back into a plausible "text" form
 * for a one-shot replay chunk: passed through unchanged if it's already a
 * string (the `jsonMode: false` case), otherwise `JSON.stringify`'d (the
 * `jsonMode: true` case, where the cached value is the *parsed* result, not
 * the original raw text). This is a reasonable reconstruction, not a
 * byte-identical replay of whatever text the model originally streamed,
 * good enough for `for await (const c of chunks)` call sites that don't
 * branch on hit vs. miss, which is the only thing a cache-hit replay needs
 * to support.
 */
function toReplayText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/**
 * Builds a trivially-exhausted one-shot `chunks` iterable from an
 * already-known value, used for a `cachedCall` cache hit, where there's no
 * live generation to relay (see `VernLLM.cachedCall`'s docs). No `usage`
 * chunk is emitted: a cache hit spent no real tokens, so there's nothing to
 * report, matching how non-streaming `cachedCall` never calls `onUsage` on
 * a hit either.
 *
 * `hasTools` must reflect whether the *original* call that produced this
 * cached value had `tools` set, that's what determines whether `value` is
 * `T` directly or a `CallWithToolsResult<T>` wrapper, and it isn't
 * something that can be reliably guessed from the value's shape alone
 * (a `schema`-validated `T` could coincidentally look like a
 * `CallWithToolsResult`).
 */
export function buildReplayChunks<T>(
  value: T | CallWithToolsResult<T>,
  hasTools: boolean,
): AsyncIterable<StreamChunk> {
  const items: StreamChunk[] = [];

  if (hasTools) {
    const result = value as CallWithToolsResult<T>;

    if (result.type === 'tool_calls') {
      result.toolCalls.forEach((toolCall, index) => {
        items.push({
          type: 'tool_call_delta',
          index,
          id: toolCall.id,
          name: toolCall.name,
          argsDelta: JSON.stringify(toolCall.arguments ?? {}),
          // A replay is always the whole value in one shot, never a
          // fragment, same as Gemini's one-shot tool_call_delta chunks.
          complete: true,
        });
      });

      if (result.content) items.push({ type: 'text-delta', delta: result.content });
    } else {
      items.push({ type: 'text-delta', delta: toReplayText(result.content) });
    }
  } else {
    items.push({ type: 'text-delta', delta: toReplayText(value) });
  }

  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

/**
 * Streaming counterpart to `buildReplayChunks` for a `cachedCall` that
 * *joined* an already-in-flight call for the same key rather than
 * triggering one itself (see `runCachedStream`'s in-flight-coalescing
 * path): there's no live stream to relay (it isn't this call's stream to
 * relay, see the joiner-path comment in `runCachedStream`), but there's
 * also no value yet, only a pending promise for one. Waits for `promise`,
 * then delegates to `buildReplayChunks`. If `promise` rejects, iterating
 * `chunks` throws that same error, consistent with how a live stream's
 * `chunks` throws on a mid-stream failure.
 */
export function buildReplayChunksFromPromise<T>(
  promise: Promise<T | CallWithToolsResult<T>>,
  hasTools: boolean,
): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      const value = await promise;

      yield* buildReplayChunks(value, hasTools);
    },
  };
}
