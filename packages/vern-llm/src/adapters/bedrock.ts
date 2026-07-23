import type { LLMClient } from '../types/index.js';

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
      messages: Array<{ role: 'user' | 'assistant'; content: Array<{ text: string }> }>;
      system?: Array<{ text: string }>;
      inferenceConfig?: { temperature?: number; maxTokens?: number };
      toolConfig?: {
        tools: Array<{
          toolSpec: {
            name: string;
            description?: string;
            inputSchema: { json: Record<string, unknown> };
          };
        }>;
        toolChoice?: { tool: { name: string } };
      };
    },
    options: { signal: AbortSignal },
  ): Promise<{
    output?: {
      message?: {
        content?: Array<{ text?: string; toolUse?: { name?: string; input?: unknown } }>;
      };
    };
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
 * `response_format: json_schema` is mapped to Converses `toolConfig`: a
 * single tool is defined from the schema and `toolChoice` forces the model
 * to call it, constraining output at generation time rather than merely
 * instructing for it via prompt text. Native tool support varies by model
 * family (most current-generation ones support it via Converse; check your
 * specific `modelId` if a call fails with an unsupported-parameter error).
 * `response_format: json_object` (no schema to build a tool from) and
 * `reasoning_effort` (no Converse equivalent) fall back to a system-prompt
 * instruction and are dropped respectively.
 */
export function fromBedrock(bedrockClient: BedrockConverseClient): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const systemMessage = params.messages.find((m) => m.role === 'system');
          // Keep both user and assistant turns, in order, so conversation
          // history survives instead of collapsing to consecutive user turns.
          const conversationMessages = params.messages.filter(
            (m): m is typeof m & { role: 'user' | 'assistant' } =>
              m.role === 'user' || m.role === 'assistant',
          );

          const toolName =
            params.response_format?.type === 'json_schema'
              ? params.response_format.json_schema.name
              : undefined;

          let jsonInstruction: string | undefined;
          let toolConfig:
            | NonNullable<Parameters<BedrockConverseClient['converse']>[0]['toolConfig']>
            | undefined;

          if (params.response_format?.type === 'json_schema' && toolName) {
            const { schema, description } = params.response_format.json_schema;
            toolConfig = {
              tools: [{ toolSpec: { name: toolName, description, inputSchema: { json: schema } } }],
              toolChoice: { tool: { name: toolName } },
            };
          } else if (params.response_format?.type === 'json_object') {
            // No schema to build a tool from, fall back to a prompt instruction
            jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
          }

          const systemParts = [systemMessage?.content, jsonInstruction].filter((s): s is string =>
            Boolean(s),
          );

          const response = await bedrockClient.converse(
            {
              modelId: params.model,
              messages: conversationMessages.map((m) => ({
                role: m.role,
                content: [{ text: m.content }],
              })),
              system: systemParts.length ? systemParts.map((text) => ({ text })) : undefined,
              inferenceConfig: {
                temperature: params.temperature,
                maxTokens: params.max_tokens,
              },
              ...(toolConfig ? { toolConfig } : {}),
            },
            options,
          );

          let text: string;
          if (toolName) {
            // Forced tool-use: the schema-conforming payload arrives as the
            // toolUse content block's already-parsed `input`, not as text.
            // Re-serialize it to JSON so it flows through the same
            // string-content contract every other adapter uses.
            const toolUseBlock = response.output?.message?.content?.find(
              (block) => block.toolUse?.name === toolName,
            );
            text = toolUseBlock?.toolUse ? JSON.stringify(toolUseBlock.toolUse.input) : '';
          } else {
            text = response.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
          }

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
