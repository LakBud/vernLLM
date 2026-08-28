import { LLMError } from '../../../types/errors.js';

import type { StreamChunk, WireToolCall } from '../../../types/index.js';

// Bound provider-controlled tool accumulation independently of the unread
// chunk buffer: one stream can otherwise create unlimited map entries or
// append unlimited argument text before finalization runs.
const MAX_TOOL_CALLS = 10_000;
const MAX_TOOL_ARGUMENTS_LENGTH = 1_000_000;

/** One incoming tool call delta, matching `WireStreamChunk`'s `tool_call_delta` variant. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  complete?: boolean;
}

/** Accumulates streamed tool call deltas, returned by `createToolCallAccumulator`. */
export interface ToolCallAccumulator {
  /**
   * Folds one delta in and returns the matching `StreamChunk` to push
   * onward. Throws `LLMError('validation')` if the delta would push the
   * accumulator past its call count or argument length limit.
   */
  apply(delta: ToolCallDelta): StreamChunk;
  /** Shapes everything accumulated so far into wire tool calls, sorted by index. Undefined if nothing arrived. */
  toWireToolCalls(): WireToolCall[] | undefined;
}

/**
 * Tracks tool call deltas by index as they stream in, merging each
 * delta's `id`/`name`/`argumentsDelta` into a running entry. Pulled out
 * of `buildStreamResult` since it's self contained state with no
 * dependency on the iterator, the chunk buffer, or the final result
 * promise.
 */
export function createToolCallAccumulator(): ToolCallAccumulator {
  const entries = new Map<number, { id?: string; name?: string; args: string }>();

  function apply(delta: ToolCallDelta): StreamChunk {
    let entry = entries.get(delta.index);

    if (!entry) {
      // Check before creating the entry so an unbounded sequence of
      // provider supplied indices cannot grow the map.
      if (entries.size >= MAX_TOOL_CALLS) {
        throw new LLMError(
          `Stream contained more than ${MAX_TOOL_CALLS} distinct tool calls`,
          'validation',
        );
      }

      entry = { args: '' };
    }

    const argumentsDelta = delta.argumentsDelta ?? '';
    // Check before concatenation: string growth is the other unbounded
    // path, including when one delta is already very large.
    if (entry.args.length + argumentsDelta.length > MAX_TOOL_ARGUMENTS_LENGTH) {
      throw new LLMError(
        `Tool call arguments exceeded the ${MAX_TOOL_ARGUMENTS_LENGTH}-character stream limit`,
        'validation',
      );
    }

    entry.id ??= delta.id;
    entry.name ??= delta.name;
    entry.args += argumentsDelta;
    entries.set(delta.index, entry);

    return {
      type: 'tool_call_delta',
      index: delta.index,
      id: delta.id,
      name: delta.name,
      argsDelta: delta.argumentsDelta,
      complete: delta.complete,
    };
  }

  function toWireToolCalls(): WireToolCall[] | undefined {
    if (!entries.size) return undefined;

    return [...entries.entries()]
      .sort(([indexA], [indexB]) => indexA - indexB)
      .map(([, entry]) => ({
        id: entry.id ?? '',
        type: 'function' as const,
        function: { name: entry.name ?? '', arguments: entry.args },
      }));
  }

  return { apply, toWireToolCalls };
}
