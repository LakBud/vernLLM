import { throwMissingForcedJsonSchemaTool } from '../internal/forcedJsonSchemaTool.js';
import { promptTokens, promptTokensDetails } from './response.js';

import type { ThinkingBlock, WireStreamChunk } from '../../types/index.js';
import type { AnthropicStreamEvent, AnthropicUsage } from './types.js';

type StreamEvent<T extends AnthropicStreamEvent['type']> = Extract<
  AnthropicStreamEvent,
  { type: T }
>;

/** What the stream loop remembers between events. */
interface StreamState {
  /** The forced json-schema tool, whose input is the structured output. */
  toolName: string | undefined;
  /**
   * Deltas only carry a block index, so each block's kind is kept. A
   * `json-tool` block's input is re-emitted as text, the streaming
   * counterpart of `create` unwrapping the forced tool.
   */
  blockKinds: Map<number, 'text' | 'tool_use' | 'json-tool'>;
  /** Reasoning is only usable once whole, so it is gathered per block until its stop event. */
  thinkingBlocks: Map<number, ThinkingBlock>;
  /** `message_start`'s usage, completed by `message_delta`'s cumulative input counts. */
  startUsage: AnthropicUsage | undefined;
  sawJsonTool: boolean;
}

function* onBlockStart(
  state: StreamState,
  event: StreamEvent<'content_block_start'>,
): Generator<WireStreamChunk> {
  const block = event.content_block;

  switch (block.type) {
    case 'tool_use': {
      const kind = block.name === state.toolName ? 'json-tool' : 'tool_use';
      state.blockKinds.set(event.index, kind);

      if (kind === 'json-tool') {
        state.sawJsonTool = true;
      } else if (!state.toolName) {
        // With a forced tool in play, any other tool_use block is
        // unexpected and would corrupt the JSON the caller expects.
        yield { type: 'tool_call_delta', index: event.index, id: block.id, name: block.name };
      }
      return;
    }
    case 'thinking':
      state.thinkingBlocks.set(event.index, {
        type: 'thinking',
        thinking: block.thinking ?? '',
        signature: block.signature ?? '',
      });
      return;
    case 'redacted_thinking':
      state.thinkingBlocks.set(event.index, { type: 'redacted_thinking', data: block.data ?? '' });
      return;
    default:
      state.blockKinds.set(event.index, 'text');
  }
}

function* onBlockDelta(
  state: StreamState,
  event: StreamEvent<'content_block_delta'>,
): Generator<WireStreamChunk> {
  const { delta } = event;

  switch (delta.type) {
    case 'text_delta':
      // Text next to a forced json-schema tool would corrupt its JSON
      // payload in the same buffer, so it is dropped then.
      if (!state.toolName) yield { type: 'text-delta', delta: delta.text };
      return;
    case 'thinking_delta': {
      const block = state.thinkingBlocks.get(event.index);
      if (block?.type === 'thinking') block.thinking += delta.thinking;
      // Reasoning reaches the caller only at content_block_stop, so a ping
      // keeps a long thinking block from idling out.
      yield { type: 'ping' };
      return;
    }
    case 'signature_delta': {
      const block = state.thinkingBlocks.get(event.index);
      if (block?.type === 'thinking') block.signature += delta.signature;
      yield { type: 'ping' };
      return;
    }
    case 'input_json_delta':
      if (state.blockKinds.get(event.index) === 'json-tool') {
        yield { type: 'text-delta', delta: delta.partial_json };
      } else if (!state.toolName) {
        yield { type: 'tool_call_delta', index: event.index, argumentsDelta: delta.partial_json };
      }
  }
}

function* onBlockStop(
  state: StreamState,
  event: StreamEvent<'content_block_stop'>,
): Generator<WireStreamChunk> {
  const block = state.thinkingBlocks.get(event.index);

  if (block) {
    state.thinkingBlocks.delete(event.index);
    yield { type: 'thinking_block', block };
  }
}

const CUMULATIVE_INPUT_KEYS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

/**
 * `message_start`'s usage with `message_delta`'s input counts laid over it. Those are cumulative
 * whole message totals, omitted when they don't apply, so, as in Anthropic's own stream
 * accumulator, a present value overwrites and is never added.
 */
function withCumulativeInput(
  start: AnthropicUsage | undefined,
  delta: StreamEvent<'message_delta'>['usage'],
): AnthropicUsage {
  const merged: AnthropicUsage = { ...start };

  for (const key of CUMULATIVE_INPUT_KEYS) {
    const value = delta?.[key];
    if (value !== undefined && value !== null) merged[key] = value;
  }

  return merged;
}

function usageChunk(state: StreamState, event: StreamEvent<'message_delta'>): WireStreamChunk {
  const usage = withCumulativeInput(state.startUsage, event.usage);
  const inputTokens = promptTokens(usage) ?? 0;
  const outputTokens = event.usage?.output_tokens ?? 0;
  const thinkingTokens = event.usage?.output_tokens_details?.thinking_tokens;

  return {
    type: 'usage',
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: promptTokensDetails(usage),
      ...(thinkingTokens !== undefined
        ? { completion_tokens_details: { reasoning_tokens: thinkingTokens } }
        : {}),
    },
  };
}

/**
 * Translates Anthropic stream events into wire chunks. With `toolName` set,
 * only the forced json-schema tool's input comes through, as text.
 */
export async function* toWireStreamChunks(
  stream: AsyncIterable<AnthropicStreamEvent>,
  toolName: string | undefined,
): AsyncGenerator<WireStreamChunk> {
  const state: StreamState = {
    toolName,
    blockKinds: new Map(),
    thinkingBlocks: new Map(),
    startUsage: undefined,
    sawJsonTool: false,
  };

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start':
        state.startUsage = event.message.usage;
        break;
      case 'content_block_start':
        yield* onBlockStart(state, event);
        break;
      case 'content_block_delta':
        yield* onBlockDelta(state, event);
        break;
      case 'content_block_stop':
        yield* onBlockStop(state, event);
        break;
      case 'message_delta':
        yield usageChunk(state, event);
        break;
      case 'ping':
        // Resets the idle-timeout clock.
        yield { type: 'ping' };
    }
  }

  if (toolName && !state.sawJsonTool) throwMissingForcedJsonSchemaTool('Anthropic', toolName);
}
