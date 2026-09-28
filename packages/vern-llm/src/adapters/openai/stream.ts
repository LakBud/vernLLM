import type { WireStreamChunk } from '../../types/index.js';
import type { OpenAIStreamChunk } from './types.js';

/**
 * Translates one stream chunk. OpenAI's per-call `index` on tool call deltas
 * matches `tool_call_delta.index`, so it passes straight through.
 */
export function* toWireStreamChunks(chunk: OpenAIStreamChunk): Generator<WireStreamChunk> {
  const delta = chunk.choices?.[0]?.delta;

  if (delta?.content) {
    yield { type: 'text-delta', delta: delta.content };
  }

  if (delta?.tool_calls?.length) {
    for (const toolCall of delta.tool_calls) {
      yield {
        type: 'tool_call_delta',
        index: toolCall.index,
        id: toolCall.id,
        name: toolCall.function?.name,
        argumentsDelta: toolCall.function?.arguments,
      };
    }
  }

  if (chunk.usage) {
    yield { type: 'usage', usage: chunk.usage };
  }
}
