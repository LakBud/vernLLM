import { LLMError, type WireStreamChunk } from 'vern-llm';

import { bytesToBase64 } from './bytes.js';
import { throwMissingForcedJsonSchemaTool } from './structuredOutput.js';
import { toWireUsage } from './usage.js';

import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';

/** Maps an in-band stream exception onto the error the retry loop expects. */
function streamExceptionError(event: ConverseStreamOutput): LLMError | undefined {
  if (event.throttlingException) {
    return new LLMError(
      event.throttlingException.message || 'Bedrock throttled the request mid-stream',
      'api',
      { status: 429, code: 'provider_rate_limited' },
    );
  }

  if (event.validationException) {
    return new LLMError(
      event.validationException.message || 'Bedrock rejected the request mid-stream',
      'validation',
    );
  }

  const failure =
    event.internalServerException ??
    event.serviceUnavailableException ??
    event.modelStreamErrorException;
  if (!failure) return undefined;

  const status =
    event.modelStreamErrorException?.originalStatusCode ||
    (event.serviceUnavailableException ? 503 : 500);

  return new LLMError(failure.message || 'Bedrock reported a mid-stream error', 'api', {
    status,
    code: status >= 500 ? 'server_error' : undefined,
  });
}

type BlockStart = NonNullable<ConverseStreamOutput['contentBlockStart']>;
type BlockDelta = NonNullable<ConverseStreamOutput['contentBlockDelta']>;
type BlockStop = NonNullable<ConverseStreamOutput['contentBlockStop']>;
type Usage = NonNullable<NonNullable<ConverseStreamOutput['metadata']>['usage']>;

/** What the stream loop remembers between events. */
interface StreamState {
  /** The forced json-schema tool, whose input is the structured output. */
  toolName: string | undefined;
  /** Deltas only carry a block index, so each block's kind is kept. */
  blockKinds: Map<number, 'text' | 'tool_use' | 'json-tool'>;
  /** Reasoning is only usable once whole, so it is gathered per block until its stop event. */
  reasoning: Map<number, { text: string; signature: string; redacted?: Uint8Array }>;
  sawJsonTool: boolean;
}

function* onBlockStart(state: StreamState, event: BlockStart): Generator<WireStreamChunk> {
  const { contentBlockIndex = 0, start } = event;

  if (!start?.toolUse) {
    state.blockKinds.set(contentBlockIndex, 'text');
    return;
  }

  const kind = start.toolUse.name === state.toolName ? 'json-tool' : 'tool_use';
  state.blockKinds.set(contentBlockIndex, kind);

  if (kind === 'json-tool') {
    state.sawJsonTool = true;
  } else if (!state.toolName) {
    yield {
      type: 'tool_call_delta',
      index: contentBlockIndex,
      id: start.toolUse.toolUseId,
      name: start.toolUse.name,
    };
  }
}

function* onBlockDelta(state: StreamState, event: BlockDelta): Generator<WireStreamChunk> {
  const { contentBlockIndex = 0, delta } = event;

  // Text next to a forced json-schema tool would corrupt its JSON payload
  // in the same buffer, so it is dropped then.
  if (delta?.text !== undefined && !state.toolName) {
    yield { type: 'text-delta', delta: delta.text };
    return;
  }

  if (delta?.reasoningContent) {
    const part = delta.reasoningContent;
    const block = state.reasoning.get(contentBlockIndex) ?? { text: '', signature: '' };

    block.text += part.text ?? '';
    block.signature += part.signature ?? '';
    if (part.redactedContent) block.redacted = part.redactedContent;
    state.reasoning.set(contentBlockIndex, block);
    // Reasoning reaches the caller only at contentBlockStop, so a ping
    // keeps a long reasoning block from idling out.
    yield { type: 'ping' };
    return;
  }

  if (delta?.toolUse?.input === undefined) return;

  if (state.blockKinds.get(contentBlockIndex) === 'json-tool') {
    yield { type: 'text-delta', delta: delta.toolUse.input };
  } else if (!state.toolName) {
    yield {
      type: 'tool_call_delta',
      index: contentBlockIndex,
      argumentsDelta: delta.toolUse.input,
    };
  }
}

function* onBlockStop(state: StreamState, event: BlockStop): Generator<WireStreamChunk> {
  const index = event.contentBlockIndex ?? 0;
  const block = state.reasoning.get(index);
  if (!block) return;

  state.reasoning.delete(index);
  yield {
    type: 'thinking_block',
    block: block.redacted
      ? { type: 'redacted_thinking', data: bytesToBase64(block.redacted) }
      : { type: 'thinking', thinking: block.text, signature: block.signature },
  };
}

function usageChunk(usage: Usage): WireStreamChunk {
  return {
    type: 'usage',
    usage: toWireUsage(usage),
  };
}

/**
 * Translates Converse stream events into wire chunks. With `toolName` set,
 * only the forced json-schema tool's input comes through, as text.
 */
export async function* toWireStreamChunks(
  stream: AsyncIterable<ConverseStreamOutput>,
  toolName: string | undefined,
): AsyncGenerator<WireStreamChunk> {
  const state: StreamState = {
    toolName,
    blockKinds: new Map(),
    reasoning: new Map(),
    sawJsonTool: false,
  };

  // Events are narrowed one member at a time. Anything else, such as the
  // SDK's generated $unknown member for event kinds added after this SDK
  // version, is skipped rather than misrouted.
  for await (const event of stream) {
    const failure = streamExceptionError(event);
    if (failure) throw failure;

    if (event.contentBlockStart) yield* onBlockStart(state, event.contentBlockStart);
    else if (event.contentBlockDelta) yield* onBlockDelta(state, event.contentBlockDelta);
    else if (event.contentBlockStop) yield* onBlockStop(state, event.contentBlockStop);
    else if (event.metadata?.usage) yield usageChunk(event.metadata.usage);
  }

  if (toolName && !state.sawJsonTool) throwMissingForcedJsonSchemaTool(toolName);
}
