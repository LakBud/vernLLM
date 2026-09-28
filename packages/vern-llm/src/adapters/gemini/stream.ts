import { synthesizeToolCallId, toWireUsage } from './response.js';

import type { WireStreamChunk } from '../../types/index.js';
import type { GeminiStream, GeminiUsage } from './types.js';

/**
 * Translates Gemini's partial responses into wire chunks. Function calls
 * arrive whole, so each is one complete `tool_call_delta`.
 */
export async function* toWireStreamChunks(stream: GeminiStream): AsyncGenerator<WireStreamChunk> {
  let toolCallIndex = 0;
  const nameOccurrence = new Map<string, number>();
  let lastUsage: GeminiUsage | undefined;

  for await (const chunk of stream) {
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];

    for (const part of parts) {
      if (part.text) {
        yield { type: 'text-delta', delta: part.text };
      }

      if (part.functionCall) {
        const name = part.functionCall.name;
        const nativeId = part.functionCall.id;
        const occurrenceIndex = name ? (nameOccurrence.get(name) ?? 0) : 0;
        if (name) nameOccurrence.set(name, occurrenceIndex + 1);

        yield {
          type: 'tool_call_delta',
          index: toolCallIndex,
          id: nativeId ?? (name ? synthesizeToolCallId(name, occurrenceIndex) : undefined),
          name: part.functionCall.name,
          argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
          // INVARIANT: Gemini sends each call's args whole, never
          // incrementally. The "INVARIANT: hardcodes complete: true"
          // stream test guards this.
          complete: true,
        } satisfies WireStreamChunk;
        toolCallIndex++;
      }
    }

    if (chunk.usageMetadata) {
      lastUsage = chunk.usageMetadata;
    }
  }

  // Gemini only reliably reports usage on the last chunk.
  if (lastUsage) {
    yield { type: 'usage', usage: toWireUsage(lastUsage) };
  }
}
