import { finishReason } from '../internal/finishReason.js';
import {
  assertForcedJsonSchemaToolInputIsObject,
  throwMissingForcedJsonSchemaTool,
} from '../internal/forcedJsonSchemaTool.js';

import type { ThinkingBlock, WireToolCall } from '../../types/index.js';
import type { AnthropicResponse, AnthropicUsage } from './types.js';

const finite = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Every input token: uncached, cache writes and cache reads. `undefined` when none is reported,
 * so a missing count isn't passed off as 0; a non finite value counts as 0 rather than poisoning
 * the sum.
 */
export function promptTokens(usage: AnthropicUsage | undefined): number | undefined {
  const parts = [
    usage?.input_tokens,
    usage?.cache_creation_input_tokens,
    usage?.cache_read_input_tokens,
  ];

  if (parts.every((part) => part === undefined || part === null)) return undefined;

  return parts.reduce<number>((sum, part) => sum + finite(part), 0);
}

/** The cache split, in the wire shape. `undefined` when there is no usage. */
export function promptTokensDetails(usage: AnthropicUsage | undefined) {
  if (!usage) return undefined;

  const byTtl = usage.cache_creation
    ? {
        '5m': finite(usage.cache_creation.ephemeral_5m_input_tokens),
        '1h': finite(usage.cache_creation.ephemeral_1h_input_tokens),
      }
    : undefined;

  return {
    cached_tokens: usage.cache_read_input_tokens ?? undefined,
    cache_write_tokens: usage.cache_creation_input_tokens ?? undefined,
    ...(byTtl ? { cache_write_tokens_by_ttl: byTtl } : {}),
  };
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
      prompt_tokens_details: promptTokensDetails(response.usage),
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
