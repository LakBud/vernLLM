import { LLMError, type ThinkingBlock, type WireToolCall } from 'vern-llm';

import { bytesToBase64 } from './bytes.js';
import {
  assertForcedJsonSchemaToolInputIsObject,
  throwMissingForcedJsonSchemaTool,
} from './structuredOutput.js';
import { toWireUsage } from './usage.js';

import type {
  ContentBlock as BedrockContentBlock,
  ConverseResponse,
} from '@aws-sdk/client-bedrock-runtime';

/** `stopReason` values where the model or a guardrail declined. `refusal` is not in every SDK version. */
const REFUSAL_STOP_REASONS: ReadonlySet<string> = new Set([
  'guardrail_intervened',
  'content_filtered',
  'refusal',
]);

export function isRefusalStop(stopReason: string | undefined): boolean {
  return stopReason !== undefined && REFUSAL_STOP_REASONS.has(stopReason);
}

/** The reasoning blocks of a Converse response, in order, in VernLLM's shape. */
function toThinkingBlocks(content: BedrockContentBlock[]): ThinkingBlock[] {
  return content.flatMap((block): ThinkingBlock[] => {
    const reasoning = block.reasoningContent;
    if (!reasoning) return [];

    if (reasoning.redactedContent) {
      return [{ type: 'redacted_thinking', data: bytesToBase64(reasoning.redactedContent) }];
    }

    return [
      {
        type: 'thinking',
        thinking: reasoning.reasoningText?.text ?? '',
        signature: reasoning.reasoningText?.signature ?? '',
      },
    ];
  });
}

export function toWireResponse(response: ConverseResponse, toolName: string | undefined) {
  const blocks = response.output?.message?.content ?? [];
  const thinking = toThinkingBlocks(blocks);
  let text: string;
  let wireToolCalls: WireToolCall[] | undefined;

  if (toolName) {
    // The forced tool's parsed input is the structured output; serialize it
    // back to text so it follows every other adapter's string contract.
    const toolUse = blocks.find((block) => block.toolUse?.name === toolName)?.toolUse;

    if (toolUse) {
      const { input } = toolUse;
      assertForcedJsonSchemaToolInputIsObject(toolName, input);
      text = JSON.stringify(input);
    } else if (isRefusalStop(response.stopReason)) {
      // A refusal never calls the tool; core fails it as model_refused.
      text = '';
    } else {
      throwMissingForcedJsonSchemaTool(toolName);
    }
  } else {
    text = blocks.map((c) => c.text ?? '').join('');

    const toolUses = blocks.flatMap((block) => (block.toolUse ? [block.toolUse] : []));

    if (toolUses.length) {
      wireToolCalls = toolUses.map((toolUse, i) => {
        if (!toolUse.name) {
          throw new LLMError(
            `Bedrock returned a toolUse block without a name at index ${i}.`,
            'validation',
          );
        }

        return {
          id: toolUse.toolUseId ?? `${toolUse.name}_${i}`,
          type: 'function' as const,
          function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input ?? {}) },
        };
      });
    }
  }

  return {
    choices: [
      {
        message: {
          content: text,
          ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}),
          ...(thinking.length ? { thinking } : {}),
          ...(isRefusalStop(response.stopReason) ? { refusal: response.stopReason } : {}),
        },
        ...(response.stopReason === 'max_tokens' ? { finish_reason: 'length' as const } : {}),
      },
    ],
    usage: toWireUsage(response.usage),
  };
}
