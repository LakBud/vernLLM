import { finishReason } from '../internal/finishReason.js';
import {
  assertForcedJsonSchemaToolInputIsObject,
  throwMissingForcedJsonSchemaTool,
} from '../internal/forcedJsonSchemaTool.js';

import type { ThinkingBlock, WireToolCall } from '../../types/index.js';
import type { AnthropicResponse } from './types.js';

/**
 * Input tokens that count toward Anthropic's input rate limit: cache writes
 * are added back, cache reads stay out. `undefined` when neither is
 * reported, so a missing count isn't passed off as 0; a non finite value
 * counts as 0 rather than poisoning the sum.
 */
export function promptTokens(
  usage: { input_tokens?: number; cache_creation_input_tokens?: number | null } | undefined,
): number | undefined {
  const input = usage?.input_tokens;
  const cacheWrites = usage?.cache_creation_input_tokens;

  if (input === undefined && (cacheWrites === undefined || cacheWrites === null)) return undefined;

  const finite = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  return finite(input) + finite(cacheWrites);
}

/** The reasoning blocks of a response, in order, in VernLLM's shape. */
function toThinkingBlocks(content: AnthropicResponse['content']): ThinkingBlock[] {
  return content.flatMap((block): ThinkingBlock[] => {
    if (block.type === 'thinking') {
      return [
        { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' },
      ];
    }

    if (block.type === 'redacted_thinking') {
      return [{ type: 'redacted_thinking', data: block.data ?? '' }];
    }

    return [];
  });
}

/**
 * Maps a message onto the wire response. A forced json-schema tool's input
 * becomes the text content, as the structured output.
 */
export function toWireResponse(response: AnthropicResponse, toolName: string | undefined) {
  let text: string;
  let wireToolCalls: WireToolCall[] | undefined;
  const thinking = toThinkingBlocks(response.content);

  if (toolName) {
    const toolUse = response.content.find(
      (block) => block.type === 'tool_use' && block.name === toolName,
    );

    if (!toolUse) throwMissingForcedJsonSchemaTool('Anthropic', toolName);

    assertForcedJsonSchemaToolInputIsObject('Anthropic', toolName, toolUse.input);

    text = JSON.stringify(toolUse.input);
  } else {
    text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    const toolUses = response.content.filter((block) => block.type === 'tool_use');

    if (toolUses.length) {
      wireToolCalls = toolUses.map((block) => ({
        id: block.id!,
        type: 'function' as const,
        function: { name: block.name!, arguments: JSON.stringify(block.input ?? {}) },
      }));
    }
  }

  return {
    choices: [
      {
        message: {
          content: text,
          ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}),
          ...(thinking.length ? { thinking } : {}),
        },
        ...finishReason(response.stop_reason, 'max_tokens'),
      },
    ],
    usage: {
      prompt_tokens: promptTokens(response.usage),
      completion_tokens: response.usage?.output_tokens,
      total_tokens: (promptTokens(response.usage) ?? 0) + (response.usage?.output_tokens ?? 0),
      ...(response.usage?.output_tokens_details?.thinking_tokens !== undefined
        ? {
            completion_tokens_details: {
              reasoning_tokens: response.usage.output_tokens_details.thinking_tokens,
            },
          }
        : {}),
    },
  };
}
