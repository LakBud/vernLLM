import { LLMError, type ContentBlock, type LLMClient } from '../../types/index.js';
import { assertSupportedImageMimeType } from '../internal/imageFormat.js';
import {
  budgetTokensToEffort,
  effortToBudgetTokens,
  toGeminiThinkingLevel,
  usesGeminiThinkingLevel,
  type EffortTokenTable,
} from '../internal/reasoningBudget.utils.js';

import type { ModelCapabilityOverride } from '../internal/nativeStructuredOutput.js';
import type { GeminiConfig, GeminiModels, GeminiPart, GeminiRequest } from './types.js';

/** Translates `ContentBlock[]` into Gemini parts, images as inline base64 data. */
function toGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? { inlineData: { mimeType: assertSupportedImageMimeType(block.mimeType), data: block.data } }
      : { text: block.text },
  );
}

/** Maps VernLLM's OpenAI-shaped wire `tool_choice` onto Gemini's `functionCallingConfig`. */
function toGeminiToolConfig(
  toolChoice: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
): NonNullable<
  NonNullable<Parameters<GeminiModels['generateContent']>[0]['config']>['toolConfig']
> {
  const normalized = !toolChoice ? 'auto' : toolChoice;

  switch (normalized) {
    case 'auto':
      return { functionCallingConfig: { mode: 'AUTO' } };
    case 'none':
      return { functionCallingConfig: { mode: 'NONE' } };
    case 'required':
      return { functionCallingConfig: { mode: 'ANY' } };
    default:
      return {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [normalized.function.name] },
      };
  }
}

/**
 * Maps each tool call id to its function name, from the assistant turns
 * that made the calls. Ids are opaque, native or synthesized, so the name
 * is never derived from one.
 */
function buildToolCallNameMap(
  messages: Parameters<LLMClient['chat']['completions']['create']>[0]['messages'],
): Map<string, string> {
  const map = new Map<string, string>();

  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) {
        map.set(tc.id, tc.function.name);
      }
    }
  }

  return map;
}

/**
 * Translates one wire message into a Gemini `contents` entry. Tool requests
 * become `functionCall` parts on a model turn, results `functionResponse`
 * parts on a user turn.
 */
function toGeminiContent(
  m: Extract<
    Parameters<LLMClient['chat']['completions']['create']>[0]['messages'][number],
    { role: 'user' | 'assistant' | 'tool' }
  >,
  toolCallNames: Map<string, string>,
): { role: 'user' | 'model'; parts: GeminiPart[] } {
  if (m.role === 'tool') {
    // Gemini 3 and later correlate the response by the unchanged id.
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: m.tool_call_id,
            name: toolCallNames.get(m.tool_call_id) ?? m.tool_call_id,
            response: parseToolResult(m.content),
          },
        },
      ],
    };
  }

  if (m.role === 'assistant' && m.tool_calls?.length) {
    const parts: GeminiPart[] = [];

    if (typeof m.content === 'string' && m.content) {
      parts.push({ text: m.content });
    }

    parts.push(
      ...m.tool_calls.map((tc) => ({
        functionCall: {
          id: tc.id,
          name: tc.function.name,
          args: parseToolArguments(tc.function.arguments, tc.function.name),
        },
      })),
    );

    return {
      role: 'model',
      parts,
    };
  }

  return {
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: Array.isArray(m.content) ? toGeminiParts(m.content) : [{ text: m.content ?? '' }],
  };
}

function parseToolArguments(text: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch (cause) {
    throw new LLMError(`Tool call "${toolName}" arguments are not valid JSON.`, 'parse', {
      cause,
      code: 'tool_arguments_parse_failed',
    });
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new LLMError(`Tool call "${toolName}" arguments must be a JSON object.`, 'validation');
  }

  return parsed as Record<string, unknown>;
}

/**
 * `functionResponse.response` must be an object, so any other result, parsed
 * or not, is wrapped under `output`, Gemini's convention for it.
 */
function parseToolResult(text: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = text.trim() ? JSON.parse(text) : '';
  } catch {
    parsed = text;
  }

  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    return parsed as Record<string, unknown>;
  }

  return { output: parsed };
}

/** Gemini expects parallel tool results as parts of one user entry, so a run of them is merged. */
function mergeConsecutiveFunctionResponses(
  contents: { role: 'user' | 'model'; parts: GeminiPart[] }[],
): { role: 'user' | 'model'; parts: GeminiPart[] }[] {
  const isFunctionResponseOnly = (
    c: (typeof contents)[number],
  ): c is { role: 'user'; parts: GeminiPart[] } =>
    c.role === 'user' && c.parts.length > 0 && c.parts.every((p) => 'functionResponse' in p);

  const merged: (typeof contents)[number][] = [];

  for (const c of contents) {
    const prev = merged.at(-1);

    if (isFunctionResponseOnly(c) && prev && isFunctionResponseOnly(prev)) {
      prev.parts.push(...c.parts);
    } else {
      merged.push(c);
    }
  }

  return merged;
}

/**
 * Gemini's `thinkingConfig` for a request, `undefined` when no reasoning was
 * asked for. Gemini 3 still accepts thinkingBudget, but Google warns it "may
 * result in unexpected performance", so thinkingLevel is sent there. 0 and
 * -1 have no level, and collapse to MINIMAL, the closest to off. Earlier
 * models get thinkingBudget, where 0 (off) and -1 (automatic) pass through
 * unchanged.
 */
function resolveGeminiThinking(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
  effortTokenTable?: EffortTokenTable,
  thinkingLevelModels?: ModelCapabilityOverride,
): GeminiConfig['thinkingConfig'] {
  if (usesGeminiThinkingLevel(params.model, thinkingLevelModels)) {
    const effortTier =
      params.reasoning_effort ??
      (params.budget_tokens !== undefined
        ? budgetTokensToEffort(params.budget_tokens, effortTokenTable)
        : undefined);

    return effortTier === undefined
      ? undefined
      : { thinkingLevel: toGeminiThinkingLevel(effortTier, params.model) };
  }

  const thinkingBudget =
    params.budget_tokens ??
    (params.reasoning_effort
      ? effortToBudgetTokens(params.reasoning_effort, effortTokenTable)
      : undefined);

  return thinkingBudget === undefined ? undefined : { thinkingBudget };
}

/** Builds the request shared by `create` and `createStream`, which add `abortSignal`. */
export function buildGeminiRequest(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
  effortTokenTable?: EffortTokenTable,
  thinkingLevelModels?: ModelCapabilityOverride,
): GeminiRequest {
  const systemMessage = params.messages.find((m) => m.role === 'system');
  const conversationMessages = params.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
  );

  const wantsJson = Boolean(params.response_format);
  const config: GeminiConfig = {
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    maxOutputTokens: params.max_tokens,
    ...(systemMessage
      ? // System turns are always plain strings; only user turns can carry ContentBlock[]
        { systemInstruction: { parts: [{ text: systemMessage.content as string }] } }
      : {}),
  };

  if (wantsJson) {
    config.responseMimeType = 'application/json';
  }

  if (params.response_format?.type === 'json_schema') {
    const { schema, description } = params.response_format.json_schema;

    config.responseSchema = {
      ...schema,
      ...(description ? { description } : {}),
    };
  }

  if (params.tools?.length) {
    config.tools = [
      {
        functionDeclarations: params.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
    config.toolConfig = toGeminiToolConfig(params.tool_choice);
  }

  const thinkingConfig = resolveGeminiThinking(params, effortTokenTable, thinkingLevelModels);
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;

  const toolCallNames = buildToolCallNameMap(conversationMessages);

  return {
    model: params.model,
    contents: mergeConsecutiveFunctionResponses(
      conversationMessages.map((m) => toGeminiContent(m, toolCallNames)),
    ),
    config,
  };
}
