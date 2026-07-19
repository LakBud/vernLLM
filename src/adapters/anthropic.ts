import type { LLMClient } from '../types.js';

/** Minimal structural type for the Anthropic SDKs `messages.create` */
interface AnthropicClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      },
      options: { signal: AbortSignal },
    ): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

/**
 * Wraps an Anthropic SDK client so it satisfies the same `LLMClient`
 * interface VernLLM uses for OpenAI/Groq. Anthropics Messages API has no
 * `response_format: json_object` equivalent, so when the caller requests
 * JSON mode, this adapter appends an instruction to the system prompt
 * asking the model to respond with JSON only
 */
export function fromAnthropic(anthropicClient: AnthropicClient): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const systemMessage = params.messages.find((m) => m.role === 'system');
          const userMessages = params.messages.filter((m) => m.role === 'user');

          // Anthropics Messages API has no `response_format: json_object` or
          // `json_schema` equivalent, so both are emulated via system prompt
          // instructions. For json_schema, the schema itself is embedded so the
          // model has something concrete to conform to (not provider-enforced,
          // unlike OpenAIs native structured outputs)
          let jsonInstruction: string | undefined;
          if (params.response_format?.type === 'json_schema') {
            const { name, schema } = params.response_format.json_schema;
            jsonInstruction = `Respond with valid JSON only, no prose or markdown fences. The JSON must conform to this schema (name: "${name}"):\n${JSON.stringify(schema)}`;
          } else if (params.response_format?.type === 'json_object') {
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
              messages: userMessages.map((m) => ({ role: 'user' as const, content: m.content })),
            },
            options,
          );

          const text = response.content.find((block) => block.type === 'text')?.text ?? '';

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