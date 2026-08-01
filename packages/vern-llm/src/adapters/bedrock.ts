import { assertSupportedImageMimeType } from '../internal/imageFormat.js';

import type { ContentBlock, LLMClient } from '../types/index.js';

/** Bedrock Converse's supported inline image formats. */
type BedrockImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** Bedrock Converse's native per-block content shape for a message. */
type BedrockContentBlock =
  | { text: string }
  | { image: { format: BedrockImageFormat; source: { bytes: Uint8Array } } };

/**
 * Minimal structural type matching AWS Bedrock's Converse API. This is
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
      messages: Array<{ role: 'user' | 'assistant'; content: BedrockContentBlock[] }>;
      system?: Array<{ text: string }>;
      inferenceConfig?: { temperature?: number; maxTokens?: number };
      toolConfig?: {
        tools: Array<{
          toolSpec: {
            name: string;
            description?: string;
            inputSchema: { json: Record<string, unknown> };
            strict?: boolean;
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

/** Maps a `ContentBlock` image MIME type, already validated, to Converse's `format` enum. */
function toBedrockImageFormat(mimeType: string): BedrockImageFormat {
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

/**
 * Decodes base64 image data into the raw `Uint8Array` bytes Converse's
 * `image.source.bytes` expects (unlike Anthropic/Gemini/OpenAI, which all
 * take base64 strings directly). Uses `Buffer`, since this adapter, like
 * the rest of the package, targets Node.
 */
function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/**
 * Translates a VernLLM `ContentBlock[]` into Converse's native content-block
 * array: text blocks pass through as `{ text }`, image blocks become
 * `{ image: { format, source: { bytes } } }` with the base64 payload decoded
 * to raw bytes, since Converse doesn't accept base64 strings directly.
 */
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

/**
 * Wraps a Bedrock Converse-API client so it satisfies the `LLMClient`
 * interface VernLLM uses for OpenAI/Groq. The Converse API is unified
 * across Bedrock's model families (Anthropic, Titan, Llama, Mistral, etc.),
 * so unlike raw per-model Bedrock invocation, this one adapter works
 * regardless of which underlying model `modelId` points at, as long as
 * that model supports Converse (most current-generation ones do)
 *
 * `response_format: json_schema` is mapped to Converse's `toolConfig`: a
 * single tool is defined from the schema, description, and strictness settings,
 * and `toolChoice` forces the model to call it. Provider-constrained schema
 * matching applies only when `strict: true` is forwarded and supported.
 * Native tool support varies by model family (most current-generation ones
 * support it via Converse; check your specific `modelId` if a call fails
 * with an unsupported-parameter error).
 *
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
            const { schema, description, strict } = params.response_format.json_schema;

            toolConfig = {
              tools: [
                {
                  toolSpec: {
                    name: toolName,
                    description,
                    inputSchema: { json: schema },
                    strict,
                  },
                },
              ],
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
                content: Array.isArray(m.content)
                  ? toBedrockContent(m.content)
                  : [{ text: m.content }],
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
