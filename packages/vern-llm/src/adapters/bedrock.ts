import type { LLMClient } from '../types.js';

/**
 * Minimal structural type matching AWS Bedrocks Converse API. This is
 * intentionally NOT `BedrockRuntimeClient` itself, the AWS SDK v3 client
 * exposes `.send(command)`, not a direct `.converse()` method, and pulling
 * in `@aws-sdk/client-bedrock-runtime` as a dependency just for its types
 * isn't worth it for a structural adapter. Wrap your client, e.g:
 *
 * ```ts
 * import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
 * const client = new BedrockRuntimeClient({ region: 'us-east-1' });
 * const converseClient = {
 *   converse: (params, options) =>
 *     client.send(new ConverseCommand(params), { abortSignal: options.signal }),
 * };
 * ```
 */
export interface BedrockConverseClient {
  converse(
    params: {
      modelId: string;
      messages: Array<{ role: 'user'; content: Array<{ text: string }> }>;
      system?: Array<{ text: string }>;
      inferenceConfig?: { temperature?: number; maxTokens?: number };
    },
    options: { signal: AbortSignal },
  ): Promise<{
    output?: { message?: { content?: Array<{ text?: string }> } };
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  }>;
}

/**
 * Wraps a Bedrock Converse-API client so it satisfies the `LLMClient`
 * interface VernLLM uses for OpenAI/Groq. The Converse API is unified
 * across Bedrocks model families (Anthropic, Titan, Llama, Mistral, etc.),
 * so unlike raw per-model Bedrock invocation, this one adapter works
 * regardless of which underlying model `modelId` points at, as long as
 * that model supports Converse (most current-generation ones do)
 *
 * Theres no uniform native JSON Schema enforcement across families here
 * (some support it via forced tool-use, which varies per model), so
 * `jsonSchema`/`jsonMode` are emulated via a system-prompt instruction, same
 * approach as the Anthropic adapter. `reasoning_effort` has no Converse
 * equivalent and is dropped
 */
export function fromBedrock(bedrockClient: BedrockConverseClient): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const systemMessage = params.messages.find((m) => m.role === 'system');
          const userMessages = params.messages.filter((m) => m.role === 'user');

          let jsonInstruction: string | undefined;
          if (params.response_format?.type === 'json_schema') {
            const { name, schema } = params.response_format.json_schema;
            jsonInstruction = `Respond with valid JSON only, no prose or markdown fences. The JSON must conform to this schema (name: "${name}"):\n${JSON.stringify(schema)}`;
          } else if (params.response_format?.type === 'json_object') {
            jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
          }

          const systemParts = [systemMessage?.content, jsonInstruction].filter((s): s is string =>
            Boolean(s),
          );

          const response = await bedrockClient.converse(
            {
              modelId: params.model,
              messages: userMessages.map((m) => ({
                role: 'user' as const,
                content: [{ text: m.content }],
              })),
              system: systemParts.length ? systemParts.map((text) => ({ text })) : undefined,
              inferenceConfig: {
                temperature: params.temperature,
                maxTokens: params.max_tokens,
              },
            },
            options,
          );

          const text = response.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';

          return {
            choices: [{ message: { content: text } }],
            usage: {
              prompt_tokens: response.usage?.inputTokens,
              completion_tokens: response.usage?.outputTokens,
              total_tokens: response.usage?.totalTokens,
            },
          };
        },
      },
    },
  };
}
