import { LLMError, type ContentBlock, type LLMClient } from '../../types/index.js';
import { planClaudeStructuredOutput, resolveClaudeThinking } from '../internal/claudeRequest.js';
import { assertSupportedImageMimeType } from '../internal/imageFormat.js';

import type { ModelCapabilityOverride } from '../internal/nativeStructuredOutput.js';
import type { EffortTokenTable } from '../internal/reasoningBudget.utils.js';
import type { AnthropicClient, AnthropicContentBlock, AnthropicRequestBody } from './types.js';

/** Translates `ContentBlock[]` into Anthropic content blocks, images as base64 sources. */
function toAnthropicContent(blocks: ContentBlock[]): AnthropicContentBlock[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? {
          type: 'image',
          source: {
            type: 'base64',
            media_type: assertSupportedImageMimeType(block.mimeType),
            data: block.data,
          },
        }
      : { type: 'text', text: block.text },
  );
}

/**
 * Anthropic's `input_schema` must be an object schema, which VernLLM's
 * freeform schemas don't guarantee, so a mismatch fails here instead of at
 * the provider.
 */
function assertObjectSchema(
  schema: Record<string, unknown>,
  toolName: string,
): { type: 'object'; [key: string]: unknown } {
  if (schema.type !== 'object') {
    throw new LLMError(
      `Tool "${toolName}"'s schema must have "type": "object" (Anthropic requires object-shaped tool parameters).`,
      'validation',
    );
  }

  return schema as { type: 'object'; [key: string]: unknown };
}

/** Maps the wire `tool_choice` onto Anthropic's; `'required'` is Anthropic's `'any'`. */
function toAnthropicToolChoice(
  toolChoice: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
):
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string }
  | undefined {
  const normalized = !toolChoice ? 'auto' : toolChoice;

  switch (normalized) {
    case 'auto':
      return { type: 'auto' };
    case 'none':
      return { type: 'none' };
    case 'required':
      return { type: 'any' };
    default:
      return { type: 'tool', name: normalized.function.name };
  }
}

/** Maps the caller's real tools, alone or next to native structured output. */
function buildAnthropicTools(
  tools: NonNullable<Parameters<LLMClient['chat']['completions']['create']>[0]['tools']>,
  toolChoiceParam: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
): {
  tools: NonNullable<Parameters<AnthropicClient['messages']['create']>[0]['tools']>;
  toolChoice: Parameters<AnthropicClient['messages']['create']>[0]['tool_choice'];
} {
  return {
    tools: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: assertObjectSchema(t.function.parameters, t.function.name),
    })),
    toolChoice: toAnthropicToolChoice(toolChoiceParam),
  };
}

const ANTHROPIC_MESSAGES = {
  toolsWithJsonSchema: (model: string) =>
    `Anthropic model "${model}" is not covered by nativeStructuredOutputModels, so ` +
    '`jsonSchema` is emulated as a forced single tool call there, which collides with the ' +
    '`tools` you also provided. Either drop `tools` or `jsonSchema` for this call, or pass ' +
    "this model in fromAnthropic's `nativeStructuredOutputModels` option once you've " +
    "confirmed it supports Anthropic's `output_config.format`.",
  jsonObject:
    'response_format: "json_object" is not supported on Anthropic. Unlike OpenAI, Anthropic ' +
    'has no API-level field that mechanically guarantees valid JSON output for this mode, so ' +
    'it used to be emulated by injecting a "respond with JSON only" instruction into the ' +
    'system prompt, a guarantee this adapter can no longer make. Use `jsonSchema` instead, ' +
    "which maps to a real API-level constraint (Anthropic's native output_config.format on " +
    'covered models, or a forced single tool call otherwise).',
};

/** Describes a forced `tool_choice` for the thinking check, `undefined` when nothing is forced. */
function describeForcedChoice(toolChoice: AnthropicRequestBody['tool_choice']): string | undefined {
  if (toolChoice?.type === 'tool') return `toolChoice forcing the "${toolChoice.name}" tool`;
  if (toolChoice?.type === 'any') return "toolChoice: 'required' (Anthropic's \"any\" tool_choice)";
  return undefined;
}

/**
 * Builds the request body shared by `create` and `createStream`.
 *
 * `toolName` is set when `jsonSchema` is emulated as a forced single tool
 * call, so the caller unwraps that tool's input back into text content.
 * On the native path it stays unset: the JSON arrives as ordinary text.
 */
export function buildAnthropicRequestBody(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
  nativeStructuredOutputModels?: ModelCapabilityOverride,
  effortTokenTable?: EffortTokenTable,
  adaptiveOnlyModels?: ModelCapabilityOverride,
  forcedToolChoiceUnsupportedModels?: ModelCapabilityOverride,
): { body: AnthropicRequestBody; toolName: string | undefined } {
  const systemMessage = params.messages.find((m) => m.role === 'system');

  // Tool results travel as user turns, since Anthropic has no tool role.
  const conversationMessages = params.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
  );

  const plan = planClaudeStructuredOutput(
    'Anthropic',
    params,
    { nativeStructuredOutputModels, forcedToolChoiceUnsupportedModels },
    ANTHROPIC_MESSAGES,
  );

  let toolName: string | undefined;
  let outputFormat: NonNullable<AnthropicRequestBody['output_config']>['format'] | undefined;
  let tools: NonNullable<AnthropicRequestBody['tools']> | undefined;
  let toolChoice: AnthropicRequestBody['tool_choice'];

  if (plan.mode === 'forcedTool') {
    const { schema, description, strict } = plan.jsonSchema;

    toolName = plan.schemaName;
    tools = [
      { name: toolName, description, input_schema: assertObjectSchema(schema, toolName), strict },
    ];
    toolChoice = { type: 'tool', name: toolName };
  } else {
    // `output_config.format` has no name, description or strict field, so
    // only the schema is sent; real tools go alongside it.
    if (plan.mode === 'native') {
      outputFormat = { type: 'json_schema', schema: plan.jsonSchema.schema };
    }

    if (params.tools?.length) {
      ({ tools, toolChoice } = buildAnthropicTools(params.tools, params.tool_choice));
    }
  }

  const resolved = resolveClaudeThinking(params, describeForcedChoice(toolChoice), {
    adaptiveOnlyModels,
    effortTokenTable,
  });
  const effort = resolved?.effort;
  const system = systemMessage?.content;

  // Anthropic rejects temperature alongside any thinking mode, and VernLLM
  // always sends one, so it is dropped whenever thinking goes out.
  const temperature = resolved ? undefined : params.temperature;

  const body: AnthropicRequestBody = {
    model: params.model,
    max_tokens: params.max_tokens,
    ...(temperature !== undefined ? { temperature } : {}),
    system: system || undefined,
    messages: mergeConsecutiveToolResults(conversationMessages.map((m) => toAnthropicMessage(m))),
    ...(tools ? { tools, tool_choice: toolChoice } : {}),
    ...(outputFormat || effort
      ? {
          output_config: {
            ...(outputFormat ? { format: outputFormat } : {}),
            ...(effort ? { effort } : {}),
          },
        }
      : {}),
    ...(resolved ? { thinking: resolved.thinking } : {}),
  };

  return { body, toolName };
}

/**
 * Anthropic requires strict role alternation, so a run of tool-result-only
 * user turns, from parallel tool calls, is merged into one.
 */
function mergeConsecutiveToolResults(
  messages: { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }[],
): { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }[] {
  const isToolResultOnly = (
    m: (typeof messages)[number],
  ): m is { role: 'user'; content: AnthropicContentBlock[] } =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === 'tool_result');

  const merged: (typeof messages)[number][] = [];

  for (const m of messages) {
    const prev = merged.at(-1);

    if (isToolResultOnly(m) && prev && isToolResultOnly(prev)) {
      prev.content.push(...m.content);
    } else {
      merged.push(m);
    }
  }

  return merged;
}

/** Translates one wire message into Anthropic's `{ role, content }` shape. */
function toAnthropicMessage(
  m: Extract<
    Parameters<LLMClient['chat']['completions']['create']>[0]['messages'][number],
    { role: 'user' | 'assistant' | 'tool' }
  >,
): { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] } {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content,
          ...(m.is_error ? { is_error: true } : {}),
        },
      ],
    };
  }

  if (m.role === 'assistant' && (m.tool_calls?.length || m.thinking?.length)) {
    // Claude requires its reasoning ahead of the text and tool calls it led to.
    const blocks: AnthropicContentBlock[] = (m.thinking ?? []).map((block) =>
      block.type === 'thinking'
        ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
        : { type: 'redacted_thinking', data: block.data },
    );

    if (m.content) blocks.push({ type: 'text', text: m.content });

    for (const tc of m.tool_calls ?? []) {
      let input: unknown;

      try {
        input = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
      } catch (cause) {
        throw new LLMError(
          `Assistant tool call "${tc.function.name}" (${tc.id}) has arguments that are not valid JSON.`,
          'validation',
          { cause },
        );
      }

      if (input === null || Array.isArray(input) || typeof input !== 'object') {
        throw new LLMError(
          `Assistant tool call "${tc.function.name}" (${tc.id}) arguments must be a JSON object.`,
          'validation',
        );
      }

      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }

    return { role: 'assistant', content: blocks };
  }

  return {
    role: m.role,
    content: Array.isArray(m.content) ? toAnthropicContent(m.content) : (m.content ?? ''),
  };
}
