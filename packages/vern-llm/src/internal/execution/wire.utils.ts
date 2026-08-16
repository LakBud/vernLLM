import { LLMError } from '../../types/errors.js';

import type { LLMClient, WireToolCall } from '../../types/client.js';
import type { ToolCall, ToolDefinition } from '../../types/tools.js';

/** Translates app-facing `ToolDefinition[]` into the OpenAI-shaped wire tools array. */
export function toWireTools(
  tools: ToolDefinition[],
): NonNullable<Parameters<LLMClient['chat']['completions']['create']>[0]['tools']> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Translates app-facing `ToolCall[]` (e.g. from a replayed assistant turn) into wire tool_calls. */
export function toWireToolCalls(toolCalls: ToolCall[]): WireToolCall[] {
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    },
  }));
}

/**
 * Parses the provider's wire-shaped `tool_calls` back into VernLLM's
 * `ToolCall[]`. Malformed argument JSON is a `'parse'` error, same
 * convention as malformed JSON response bodies elsewhere in VernLLM.
 */
export function parseWireToolCalls(wireToolCalls: WireToolCall[]): ToolCall[] {
  return wireToolCalls.map((wc) => {
    let parsedArgs: unknown;

    try {
      parsedArgs = wc.function.arguments.trim() ? JSON.parse(wc.function.arguments) : {};
    } catch {
      throw new LLMError(`Invalid JSON arguments for tool call "${wc.function.name}"`, 'parse', {
        code: 'tool_arguments_parse_failed',
      });
    }

    return { id: wc.id, name: wc.function.name, arguments: parsedArgs };
  });
}
