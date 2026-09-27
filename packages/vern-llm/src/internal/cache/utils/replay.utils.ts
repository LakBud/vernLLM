import type { StreamChunk } from '../../../types/stream.js';
import type { CallWithToolsResult } from '../../../types/tools.js';

/**
 * A cached value as replay text: strings as is, anything else stringified. Not the original
 * streamed text, but enough for loops that don't care whether they got a hit.
 */
function toReplayText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/**
 * A one-shot `chunks` replay of a cached value. No `usage` chunk, since a hit spends nothing.
 * `hasTools` must reflect the original call, since the value's shape alone can't tell a
 * `CallWithToolsResult` from a `T`.
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
 * Replay for a joiner: waits for the in-flight value, then replays it. A rejection makes iterating
 * `chunks` throw, as a live stream would.
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
