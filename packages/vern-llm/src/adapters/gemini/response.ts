import { finishReason } from '../internal/finishReason.js';
import { refusalReason } from '../internal/refusalReason.js';

import type { WireToolCall } from '../../types/index.js';
import type { GeminiResponse, GeminiUsage } from './types.js';

/**
 * An id for a functionCall Gemini gave none, as before Gemini 3. The
 * occurrence index keeps repeated calls to one tool in a turn distinct.
 */
export function synthesizeToolCallId(name: string, occurrenceIndex: number): string {
  return `${name}#${occurrenceIndex}`;
}

/** Maps Gemini's usage metadata onto the wire usage shape. */
export function toWireUsage(usage: GeminiUsage | undefined) {
  return {
    prompt_tokens: usage?.promptTokenCount,
    completion_tokens: usage?.candidatesTokenCount,
    total_tokens: usage?.totalTokenCount,
    prompt_tokens_details: { cached_tokens: usage?.cachedContentTokenCount },
    ...(usage?.thoughtsTokenCount !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount } }
      : {}),
  };
}

/**
 * `finishReason`s where Gemini declined. `RECITATION`, `LANGUAGE` and `OTHER` stay `empty_response`,
 * since they depend on what was generated and a retry or another provider can succeed. A finish
 * reason added to the API later also falls through to `empty_response`, which retries, until it is
 * added here.
 */
const REFUSAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

/**
 * The wire `refusal` for a response or chunk. Any `promptFeedback.blockReason` counts as one,
 * `OTHER` included, unlike a candidate `finishReason` of `OTHER`: the block is on the prompt, so
 * every retry is blocked the same way.
 */
export function geminiRefusal(
  candidate: { finishReason?: string } | undefined,
  promptFeedback: { blockReason?: string } | undefined,
): { refusal?: string } {
  const blockReason = promptFeedback?.blockReason;

  if (blockReason && blockReason !== 'BLOCKED_REASON_UNSPECIFIED') return { refusal: blockReason };

  return refusalReason(candidate?.finishReason, REFUSAL_FINISH_REASONS);
}

/** Maps a Gemini response onto the wire response, naming each function call. */
export function toWireResponse(response: GeminiResponse) {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('');
  const functionCalls = parts.filter((p) => p.functionCall);

  let wireToolCalls: WireToolCall[] | undefined;

  if (functionCalls.length) {
    const nameOccurrence = new Map<string, number>();

    wireToolCalls = functionCalls.map((p) => {
      // INVARIANT: typed optional like the SDK, but Gemini always
      // names a function call part.
      const name = p.functionCall!.name!;
      const nativeId = p.functionCall!.id;
      const occurrenceIndex = nameOccurrence.get(name) ?? 0;
      nameOccurrence.set(name, occurrenceIndex + 1);

      return {
        // Gemini 3 and later send a native id; earlier models get
        // one synthesized.
        id: nativeId ?? synthesizeToolCallId(name, occurrenceIndex),
        type: 'function' as const,
        function: {
          name,
          arguments: JSON.stringify(p.functionCall!.args ?? {}),
        },
      };
    });
  }

  return {
    choices: [
      {
        message: {
          content: text,
          ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}),
          ...geminiRefusal(response.candidates?.[0], response.promptFeedback),
        },
        ...finishReason(response.candidates?.[0]?.finishReason, 'MAX_TOKENS'),
      },
    ],
    usage: toWireUsage(response.usageMetadata),
  };
}
