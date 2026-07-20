import type { LLMClient } from '../types.js';

/** Minimal structural type for the Anthropic SDKs `messages.create` */
export interface AnthropicClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        tools?: Array<{
          name: string;
          description?: string;
          input_schema: Record<string, unknown>;
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
 * Wraps an Anthropic SDK client so it satisfies the same `LLMClient`
 * interface VernLLM uses for OpenAI/Groq.
 *
 * `response_format: json_schema` is mapped to Anthropics forced tool-use:
 * a single tool is defined with `input_schema` set to the caller's schema,
 * and `tool_choice` forces the model to call it, so the output is
 * provider-constrained to match the schema rather than merely instructed
 * to via prompt text (the same guarantee OpenAIs native `json_schema` mode
 * gives, built on Anthropics tool-calling primitive instead).
 *
 * `response_format: json_object` (no schema to build a tool from) falls
 * back to a system-prompt instruction, since theres nothing to constrain
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
            const { schema, description } = params.response_format.json_schema;
            tools = [{ name: toolName, description, input_schema: schema }];
          } else if (params.response_format?.type === 'json_object') {
            // No schema to build a tool from, fall back to a prompt instruction
            jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
          }

          // `reasoning_effort` (OpenAI o-series/gpt-5 style) has no direct Anthropic
          // equivalent, Claudes extended thinking uses a token budget, not a tier
          // string, so its intentionally dropped here rather than guessed at.

          const system = [systemMessage?.content, jsonInstruction].filter(Boolean).join('\n\n');

          const response = await anthropicClient.messages.create(
            {
              model: params.model,
              max_tokens: params.max_tokens,
              temperature: params.temperature,
              system: system || undefined,
              messages: conversationMessages.map((m) => ({ role: m.role, content: m.content })),
              ...(tools ? { tools, tool_choice: { type: 'tool' as const, name: toolName! } } : {}),
            },
            options,
          );

          let text: string;
          if (toolName) {
            // Forced tool-use: the schema-conforming payload arrives as the
            // tool_use block's already-parsed `input`, not as text. Re-serialize
            // it to JSON so it flows through the same string-content contract
            // every other adapter uses (VernLLM JSON.parses the content itself).
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
