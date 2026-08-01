import { assertSupportedImageMimeType } from '../internal/imageFormat.js';

import type { ContentBlock, LLMClient } from '../types/index.js';

/** Anthropic's native per-block content shape for a message. */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Minimal structural type for the Anthropic SDK's `messages.create` */
export interface AnthropicClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>;
        tools?: Array<{
          name: string;
          description?: string;
          input_schema: Record<string, unknown>;
          strict?: boolean;
        }>;
        tool_choice?: { type: 'tool'; name: string };
      },
      options: { signal: AbortSignal },
    ): Promise<{
      content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

/**
 * Translates a VernLLM `ContentBlock[]` (our provider-agnostic multimodal
 * shape) into Anthropic's native content-block array: text blocks pass
 * through as-is, image blocks become `{ type: 'image', source: { type:
 * 'base64', media_type, data } }`.
 */
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
 * Wraps an Anthropic SDK client so it satisfies the same `LLMClient`
 * interface VernLLM uses for OpenAI/Groq.
 *
 * `response_format: json_schema` is mapped to Anthropic's forced tool-use:
 * a single tool is defined with `input_schema` set to the caller's schema,
 * `description` forwarded when provided, and `strict` forwarded when set.
 * `tool_choice` forces the model to call it. Provider-constrained schema
 * matching applies only when `strict: true` is forwarded and supported.
 *
 * `response_format: json_object` (no schema to build a tool from) falls
 * back to a system-prompt instruction, since there's nothing to constrain
 * generation against.
 */
export function fromAnthropic(anthropicClient: AnthropicClient): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const systemMessage = params.messages.find((m) => m.role === 'system');

          // Keep both user and assistant turns, in order, so multi-turn history
          // survives instead of collapsing to consecutive user messages.
          const conversationMessages = params.messages.filter(
            (m): m is typeof m & { role: 'user' | 'assistant' } =>
              m.role === 'user' || m.role === 'assistant',
          );

          const toolName =
            params.response_format?.type === 'json_schema'
              ? params.response_format.json_schema.name
              : undefined;

          let jsonInstruction: string | undefined;
          let tools:
            | NonNullable<Parameters<AnthropicClient['messages']['create']>[0]['tools']>
            | undefined;

          if (params.response_format?.type === 'json_schema' && toolName) {
            const { schema, description, strict } = params.response_format.json_schema;

            tools = [
              {
                name: toolName,
                description,
                input_schema: schema,
                strict,
              },
            ];
          } else if (params.response_format?.type === 'json_object') {
            // No schema to build a tool from, fall back to a prompt instruction
            jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
          }

          // `reasoning_effort` (OpenAI o-series/gpt-5 style) has no direct Anthropic
          // equivalent. Claude's extended thinking uses a token budget, not a tier
          // string, so it's intentionally dropped here rather than guessed at.

          const system = [systemMessage?.content, jsonInstruction].filter(Boolean).join('\n\n');

          const response = await anthropicClient.messages.create(
            {
              model: params.model,
              max_tokens: params.max_tokens,
              temperature: params.temperature,
              system: system || undefined,
              messages: conversationMessages.map((m) => ({
                role: m.role,
                content: Array.isArray(m.content) ? toAnthropicContent(m.content) : m.content,
              })),
              ...(tools ? { tools, tool_choice: { type: 'tool' as const, name: toolName! } } : {}),
            },
            options,
          );

          let text: string;

          if (toolName) {
            const toolUse = response.content.find(
              (block) => block.type === 'tool_use' && block.name === toolName,
            );

            text = toolUse ? JSON.stringify(toolUse.input) : '';
          } else {
            text = response.content.find((block) => block.type === 'text')?.text ?? '';
          }

          return {
            choices: [{ message: { content: text } }],
            usage: {
              prompt_tokens: response.usage?.input_tokens,
              completion_tokens: response.usage?.output_tokens,
              total_tokens:
                (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
            },
          };
        },
      },
    },
  };
}
