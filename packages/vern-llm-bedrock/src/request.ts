import { LLMError, type ContentBlock, type WireCallRequest } from 'vern-llm';
import {
  assertSupportedImageMimeType,
  planClaudeStructuredOutput,
  resolveClaudeThinking,
} from 'vern-llm/adapters';

import { decodeBase64 } from './bytes.js';

import type { DocumentType, ResolvedOptions, WireMessage } from './types.js';
import type {
  ContentBlock as BedrockContentBlock,
  ConverseRequest,
  ImageFormat,
  Message,
  ToolChoice,
  ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * Only decides whether a reasoning budget is worth forwarding through
 * `additionalModelRequestFields`. A false positive sends an inert field, so a
 * substring match on AWS's `anthropic.claude-*` naming is enough.
 */
function isClaudeModel(model: string): boolean {
  return model.includes('claude');
}

/** Maps an already validated `ContentBlock` image MIME type to Converse's `format`. */
function toBedrockImageFormat(mimeType: string): ImageFormat {
  switch (assertSupportedImageMimeType(mimeType)) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
  }
}

function toBedrockContent(blocks: ContentBlock[]): BedrockContentBlock[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? {
          image: {
            format: toBedrockImageFormat(block.mimeType),
            source: { bytes: decodeBase64(block.data) },
          },
        }
      : { text: block.text },
  );
}

/** Maps the wire `tool_choice` onto Converse's `toolChoice`. */
function toBedrockToolChoice(toolChoice: WireCallRequest['tool_choice']): ToolChoice {
  if (!toolChoice || toolChoice === 'auto') return { auto: {} };
  if (toolChoice === 'required') return { any: {} };

  if (toolChoice === 'none') {
    // Converse has no 'none', and falling back to 'auto' would let the model
    // call tools the caller explicitly forbade.
    throw new LLMError(
      "'none' is not supported by fromBedrock: Bedrock Converse has no " +
        '`tool_choice` equivalent to forbidding tool use while tools are still offered. Omit ' +
        '`tools` entirely for this call instead.',
      'invalid_params',
      { code: 'unsupported_capability', issues: { capability: "toolChoice: 'none'" } },
    );
  }

  return { tool: { name: toolChoice.function.name } };
}

function buildBedrockToolConfig(
  tools: NonNullable<WireCallRequest['tools']>,
  toolChoice: WireCallRequest['tool_choice'],
): ToolConfiguration {
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.function.name,
        description: t.function.description,
        inputSchema: { json: t.function.parameters as DocumentType },
      },
    })),
    toolChoice: toBedrockToolChoice(toolChoice),
  };
}

function parseToolArguments(name: string, id: string, args: string): DocumentType {
  if (!args.trim()) return {};

  try {
    return JSON.parse(args) as DocumentType;
  } catch (cause) {
    throw new LLMError(
      `Assistant tool call "${name}" (${id}) has arguments that are not valid JSON.`,
      'validation',
      { cause },
    );
  }
}

/** Converse has no tool role: tool results travel as user turns with `toolResult` blocks. */
function toBedrockMessage(m: Extract<WireMessage, { role: 'user' | 'assistant' | 'tool' }>): {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
} {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: m.tool_call_id,
            content: [{ text: m.content }],
            status: m.is_error ? 'error' : 'success',
          },
        },
      ],
    };
  }

  if (m.role === 'assistant' && (m.tool_calls?.length || m.thinking?.length)) {
    // Claude requires its reasoning ahead of the text and tool calls it led to.
    const blocks: BedrockContentBlock[] = (m.thinking ?? []).map((block) => ({
      reasoningContent:
        block.type === 'thinking'
          ? { reasoningText: { text: block.thinking, signature: block.signature } }
          : { redactedContent: decodeBase64(block.data) },
    }));

    if (m.content) blocks.push({ text: m.content });

    for (const tc of m.tool_calls ?? []) {
      blocks.push({
        toolUse: {
          toolUseId: tc.id,
          name: tc.function.name,
          input: parseToolArguments(tc.function.name, tc.id, tc.function.arguments),
        },
      });
    }

    return { role: 'assistant', content: blocks };
  }

  return {
    role: m.role,
    content: Array.isArray(m.content) ? toBedrockContent(m.content) : [{ text: m.content ?? '' }],
  };
}

/**
 * Converse requires strictly alternating roles, and tool results travel as
 * user turns, so a tool turn followed by a user message (or parallel tool
 * results) is merged into one turn, keeping block order.
 */
function mergeConsecutiveSameRole(
  messages: { role: 'user' | 'assistant'; content: BedrockContentBlock[] }[],
): Message[] {
  const merged: { role: 'user' | 'assistant'; content: BedrockContentBlock[] }[] = [];

  for (const m of messages) {
    const prev = merged.at(-1);

    if (prev && prev.role === m.role) {
      prev.content.push(...m.content);
    } else {
      merged.push({ role: m.role, content: [...m.content] });
    }
  }

  return merged;
}

const BEDROCK_MESSAGES = {
  toolsWithJsonSchema: (model: string) =>
    `Bedrock model "${model}" is not covered by nativeStructuredOutputModels, so ` +
    '`jsonSchema` is emulated as a forced single tool call there (via `toolConfig`), which ' +
    'collides with the `tools` you also provided. Either drop `tools` or `jsonSchema` for this ' +
    "call, or pass this model in fromBedrock's `nativeStructuredOutputModels` option once " +
    "you've confirmed it supports Converse's `outputConfig.textFormat`.",
  jsonObject:
    'response_format: "json_object" is not supported on Bedrock. Converse has no field that ' +
    'mechanically guarantees valid JSON output for this mode, so it used to be emulated by ' +
    'injecting a "respond with JSON only" instruction into the system prompt, a guarantee ' +
    'this adapter can no longer make. Use `jsonSchema` instead, which maps to a real ' +
    "constraint (Converse's native outputConfig.textFormat on covered models, or a forced " +
    'tool call otherwise).',
};

/** Describes a forced `toolChoice` for the thinking check, `undefined` when nothing is forced. */
function describeForcedChoice(toolChoice: ToolChoice | undefined): string | undefined {
  if (toolChoice?.tool) return `toolChoice forcing the "${toolChoice.tool.name}" tool`;
  if (toolChoice?.any) return "toolChoice: 'required' (Converse's \"any\" tool_choice)";
  return undefined;
}

/** Throws before dispatch when `toolUseSupportedModels` is set and leaves `model` out. */
function assertToolUseSupported(
  model: string,
  allowed: ResolvedOptions['toolUseSupportedModels'],
): void {
  if (!allowed) return;

  const isSupported = Array.isArray(allowed) ? allowed.includes(model) : allowed(model);

  if (!isSupported) {
    throw new LLMError(
      `Bedrock model "${model}" is not listed in toolUseSupportedModels, but this call ` +
        'requires Converse tool use (either jsonSchema emulated as a forced tool call, or real ' +
        '`tools` sent alongside native structured output).',
      'invalid_params',
      { code: 'unsupported_capability', issues: { capability: 'toolUseSupportedModels' } },
    );
  }
}

/**
 * Builds the Converse request shared by `create` and `createStream`.
 *
 * `toolName` is set when `jsonSchema` is emulated as a forced single tool
 * call, so the caller unwraps that tool's input back into text content.
 * On the native path it stays unset: the JSON arrives as ordinary text.
 */
export function buildBedrockRequest(
  params: WireCallRequest,
  options: ResolvedOptions,
): { request: ConverseRequest; toolName: string | undefined } {
  const systemMessage = params.messages.find((m) => m.role === 'system');
  const conversationMessages = params.messages.filter(
    (m): m is Extract<WireMessage, { role: 'user' | 'assistant' | 'tool' }> =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
  );

  const plan = planClaudeStructuredOutput(
    'Bedrock',
    params,
    {
      nativeStructuredOutputModels: options.nativeStructuredOutputModels,
      forcedToolChoiceUnsupportedModels: options.forcedToolChoiceUnsupportedModels,
    },
    BEDROCK_MESSAGES,
  );

  let toolName: string | undefined;
  let toolConfig: ToolConfiguration | undefined;
  let textFormat: NonNullable<ConverseRequest['outputConfig']>['textFormat'];

  if (plan.mode === 'native') {
    // Converse wants this schema as a JSON string under structure.jsonSchema,
    // unlike toolSpec's parsed object, and with no strict field.
    const { schema, description } = plan.jsonSchema;

    textFormat = {
      type: 'json_schema',
      structure: {
        jsonSchema: { schema: JSON.stringify(schema), name: plan.schemaName, description },
      },
    };
  } else if (plan.mode === 'forcedTool') {
    const { schema, description, strict } = plan.jsonSchema;

    toolName = plan.schemaName;
    toolConfig = {
      tools: [
        {
          toolSpec: {
            name: toolName,
            description,
            inputSchema: { json: schema as DocumentType },
            strict,
          },
        },
      ],
      toolChoice: { tool: { name: toolName } },
    };
  }

  // Real tools, alone or next to native output. The forced tool path built
  // its own toolConfig above and must not be overwritten.
  if (params.tools?.length && !toolName) {
    toolConfig = buildBedrockToolConfig(params.tools, params.tool_choice);
  }

  // Native output needs no tool use support, but real tools next to it do.
  if (plan.mode !== 'none' && toolConfig) {
    assertToolUseSupported(params.model, options.toolUseSupportedModels);
  }

  // Converse has no reasoning field, so Claude's own `thinking` travels in
  // additionalModelRequestFields, and adaptive effort in outputConfig.
  const resolved = isClaudeModel(params.model)
    ? resolveClaudeThinking(params, describeForcedChoice(toolConfig?.toolChoice), options)
    : undefined;
  const effort = resolved?.effort;
  const additionalModelRequestFields: DocumentType | undefined = resolved
    ? { thinking: resolved.thinking }
    : undefined;

  // Claude rejects temperature alongside any thinking mode.
  const temperature = additionalModelRequestFields ? undefined : params.temperature;

  const request: ConverseRequest = {
    modelId: params.model,
    messages: mergeConsecutiveSameRole(conversationMessages.map((m) => toBedrockMessage(m))),
    system: systemMessage?.content ? [{ text: systemMessage.content }] : undefined,
    inferenceConfig: {
      ...(temperature !== undefined ? { temperature } : {}),
      maxTokens: params.max_tokens,
    },
    ...(toolConfig ? { toolConfig } : {}),
    ...(textFormat || effort
      ? {
          outputConfig: {
            ...(textFormat ? { textFormat } : {}),
            ...(effort ? { effort } : {}),
          },
        }
      : {}),
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  };

  return { request, toolName };
}
