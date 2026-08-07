import { assertSupportedImageMimeType } from '../internal/imageFormat.js';
import {
  LLMError,
  type ContentBlock,
  type LLMClient,
  type WireStreamChunk,
  type WireToolCall,
} from '../types/index.js';

/** Bedrock Converse's supported inline image formats. */
type BedrockImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** Bedrock Converse's native per-block content shape for a message. */
type BedrockContentBlock =
  | { text: string }
  | { image: { format: BedrockImageFormat; source: { bytes: Uint8Array } } }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | {
      toolResult: {
        toolUseId: string;
        content: Array<{ text: string }>;
        status?: 'success' | 'error';
      };
    };

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
        toolChoice?:
          | { tool: { name: string } }
          | { auto: Record<string, never> }
          | { any: Record<string, never> };
      };
    },
    options: { signal: AbortSignal },
  ): Promise<{
    output?: {
      message?: {
        content?: Array<{
          text?: string;
          toolUse?: { toolUseId?: string; name?: string; input?: unknown };
        }>;
      };
    };
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  }>;

  /**
   * Optional. Required only for `stream: true` calls. Takes the same
   * request shape `converse` does, returning `{ stream }` — matching
   * `ConverseStreamCommand`'s real AWS SDK v3 output shape, an
   * `AsyncIterable` of incremental events under a `stream` property,
   * rather than the whole response being the iterable directly.
   */
  converseStream?(
    params: Parameters<BedrockConverseClient['converse']>[0],
    options: { signal: AbortSignal },
  ): Promise<{ stream: AsyncIterable<BedrockConverseStreamEvent> }>;
}

/**
 * One event of a Bedrock `ConverseStreamCommand` response's `stream`.
 * Content blocks (text or toolUse) are identified by `contentBlockIndex`,
 * Converse's own convention for correlating start/delta/stop events across
 * possibly-interleaved blocks — mirrored directly by VernLLM's
 * `tool_call_delta.index`.
 */
type BedrockConverseStreamEvent =
  | { messageStart: { role: 'assistant' } }
  | {
      contentBlockStart: {
        contentBlockIndex: number;
        start?: { toolUse?: { toolUseId?: string; name?: string } };
      };
    }
  | {
      contentBlockDelta: {
        contentBlockIndex: number;
        delta?: { text?: string } | { toolUse?: { input?: string } };
      };
    }
  | { contentBlockStop: { contentBlockIndex: number } }
  | { messageStop: { stopReason?: string } }
  | {
      metadata: {
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      };
    };

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
 * Optional configuration for `fromBedrock`.
 */
export interface BedrockAdapterOptions {
  /**
   * Optional preflight check for tool-use support, needed for `jsonSchema`
   * structured output. VernLLM never guesses capability from a failed
   * call's error message (AWS's error text isn't a documented, stable
   * contract), so this is opt-in: pass either a static list of tool-use
   * -capable model IDs, or a predicate function, and VernLLM will reject
   * unsupported models with a clear `LLMError('validation')` *before*
   * dispatching the request, instead of on the wire.
   *
   * Left unset (default), no preflight check runs, and a `jsonSchema` call
   * to an unsupported model surfaces Bedrock's raw `converse` error as-is.
   */
  toolUseSupportedModels?: string[] | ((modelId: string) => boolean);
}

type BedrockRequest = Parameters<BedrockConverseClient['converse']>[0];

/**
 * Builds the Converse-shaped request from VernLLM's wire params, shared
 * between `create` and `createStream` so both go through identical
 * translation (system prompt, message shaping, the jsonSchema →
 * forced-single-tool mapping, and the `toolUseSupportedModels` preflight
 * check all happen exactly once).
 *
 * Returns `toolName` alongside the request: when set, the model was forced
 * to call a single synthetic tool standing in for `jsonSchema` output, and
 * both `create` and `createStream` need to know this so they can unwrap
 * that tool call back into plain text content instead of treating it like
 * a real tool call.
 */
function buildBedrockRequest(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
  toolUseSupportedModels: BedrockAdapterOptions['toolUseSupportedModels'],
): { request: BedrockRequest; toolName: string | undefined } {
  const systemMessage = params.messages.find((m) => m.role === 'system');

  // Keep user, assistant, and tool turns, in order. Converse has no
  // separate 'tool' role: tool results travel as a user-role message
  // with toolResult content blocks, and an assistant's tool
  // requests travel as toolUse content blocks on its own turn.
  const conversationMessages = params.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
  );

  const jsonSchema =
    params.response_format?.type === 'json_schema' ? params.response_format.json_schema : undefined;

  const toolName = jsonSchema?.name.trim();

  if (jsonSchema && !toolName) {
    throw new LLMError('json_schema.name must not be empty.', 'validation');
  }

  let jsonInstruction: string | undefined;
  let toolConfig: NonNullable<BedrockRequest['toolConfig']> | undefined;

  if (jsonSchema) {
    // jsonSchema and real `tools` are mutually exclusive by the time
    // a call reaches here (enforced in vernLLM.ts).
    const { schema, description, strict } = jsonSchema;

    toolConfig = {
      tools: [
        {
          toolSpec: {
            name: toolName!,
            description,
            inputSchema: { json: schema },
            strict,
          },
        },
      ],
      toolChoice: { tool: { name: toolName! } },
    };
  } else if (params.response_format?.type === 'json_object') {
    // No schema to build a tool from, fall back to a prompt instruction
    jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
  } else if (params.tools?.length) {
    toolConfig = {
      tools: params.tools.map((t) => ({
        toolSpec: {
          name: t.function.name,
          description: t.function.description,
          inputSchema: { json: t.function.parameters },
        },
      })),
      toolChoice: toBedrockToolChoice(params.tool_choice),
    };
  }

  if (jsonSchema && toolUseSupportedModels) {
    const isSupported = Array.isArray(toolUseSupportedModels)
      ? toolUseSupportedModels.includes(params.model)
      : toolUseSupportedModels(params.model);

    if (!isSupported) {
      throw new LLMError(
        `Bedrock model "${params.model}" is not listed in toolUseSupportedModels, but jsonSchema structured output requires Converse tool use.`,
        'validation',
      );
    }
  }

  const systemParts = [systemMessage?.content, jsonInstruction].filter((s): s is string =>
    Boolean(s),
  );

  const request: BedrockRequest = {
    modelId: params.model,
    messages: mergeConsecutiveToolResults(conversationMessages.map((m) => toBedrockMessage(m))),
    system: systemParts.length ? systemParts.map((text) => ({ text })) : undefined,
    inferenceConfig: {
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      maxTokens: params.max_tokens,
    },
    ...(toolConfig ? { toolConfig } : {}),
  };

  return { request, toolName };
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
 * Native tool support varies by model family; pass
 * `toolUseSupportedModels` to preflight-check it (see
 * `BedrockAdapterOptions`), otherwise a `jsonSchema` call to an
 * unsupported model surfaces Bedrock's raw error unchanged.
 *
 * `response_format: json_object` (no schema to build a tool from) and
 * `reasoning_effort` (no Converse equivalent) fall back to a system-prompt
 * instruction and are dropped respectively.
 *
 * `tools` maps to Converse's native `toolConfig`/`toolUse`/`toolResult`;
 * `tool_choice` maps to `toolConfig.toolChoice`. Mutually exclusive with
 * `jsonSchema` by the time a call reaches here (enforced in vernLLM.ts).
 *
 * `createStream` calls `converseStream` (optional on `BedrockConverseClient`
 * — required only if the caller sets `stream: true`) and translates its
 * `contentBlockStart`/`contentBlockDelta`/`metadata` events into
 * `WireStreamChunk`s. Content blocks are tracked by `contentBlockIndex`,
 * same as `fromAnthropic`'s block-index tracking (Converse's streaming
 * shape is structurally close to Anthropic's own, both being tool-use-aware
 * content-block streams) — including the same `json-tool` unwrapping: a
 * `jsonSchema`-forced tool's `toolUse.input` deltas are re-emitted as
 * `text-delta`, not `tool_call_delta`, so the accumulated result lands in
 * `finalizeResponse`'s `content` path exactly like the non-streaming
 * `create` branch above unwraps it.
 */
export function fromBedrock(
  bedrockClient: BedrockConverseClient,
  options?: BedrockAdapterOptions,
): LLMClient {
  const toolUseSupportedModels = options?.toolUseSupportedModels;

  return {
    chat: {
      completions: {
        async create(params, requestOptions) {
          const { request, toolName } = buildBedrockRequest(params, toolUseSupportedModels);

          const response = await bedrockClient.converse(request, requestOptions);

          let text: string;
          let wireToolCalls: WireToolCall[] | undefined;

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
            const blocks = response.output?.message?.content ?? [];

            text = blocks.map((c) => c.text ?? '').join('');

            const toolUses = blocks.filter(
              (
                block,
              ): block is { toolUse: { toolUseId?: string; name?: string; input?: unknown } } =>
                Boolean(block.toolUse),
            );

            if (toolUses.length) {
              wireToolCalls = toolUses.map((block, i) => {
                const toolUse = block.toolUse;

                if (!toolUse.name) {
                  throw new LLMError(
                    `Bedrock returned a toolUse block without a name at index ${i}.`,
                    'validation',
                  );
                }

                return {
                  id: toolUse.toolUseId ?? `${toolUse.name}_${i}`,
                  type: 'function' as const,
                  function: {
                    name: toolUse.name,
                    arguments: JSON.stringify(toolUse.input ?? {}),
                  },
                };
              });
            }
          }

          return {
            choices: [
              {
                message: { content: text, ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}) },
              },
            ],
            usage: {
              prompt_tokens: response.usage?.inputTokens,
              completion_tokens: response.usage?.outputTokens,
              total_tokens: response.usage?.totalTokens,
            },
          };
        },

        async *createStream(params, requestOptions) {
          if (!bedrockClient.converseStream) {
            throw new LLMError(
              'stream: true requires a Bedrock client with converseStream',
              'validation',
            );
          }

          const { request, toolName } = buildBedrockRequest(params, toolUseSupportedModels);

          const { stream } = await bedrockClient.converseStream(request, requestOptions);

          const blockKinds = new Map<number, 'text' | 'tool_use' | 'json-tool'>();

          for await (const event of stream) {
            if ('contentBlockStart' in event) {
              const { contentBlockIndex, start } = event.contentBlockStart;

              if (start?.toolUse) {
                const kind = start.toolUse.name === toolName ? 'json-tool' : 'tool_use';

                blockKinds.set(contentBlockIndex, kind);

                if (kind === 'tool_use') {
                  yield {
                    type: 'tool_call_delta',
                    index: contentBlockIndex,
                    id: start.toolUse.toolUseId,
                    name: start.toolUse.name,
                  };
                }
              } else {
                blockKinds.set(contentBlockIndex, 'text');
              }
            } else if ('contentBlockDelta' in event) {
              const { contentBlockIndex, delta } = event.contentBlockDelta;

              // Only surfaced as real content when there's no forced
              // json-schema tool in play — see the identical guard (and
              // its full rationale) in `fromAnthropic`'s `createStream`.
              // Converse's streaming shape is structurally close enough to
              // Anthropic's own that the same corruption risk applies: a
              // genuine text block alongside a forced tool call would
              // otherwise get concatenated into the same buffer as the
              // tool's JSON payload.
              if (delta && 'text' in delta && delta.text !== undefined && !toolName) {
                yield { type: 'text-delta', delta: delta.text };
              } else if (delta && 'toolUse' in delta && delta.toolUse?.input !== undefined) {
                const kind = blockKinds.get(contentBlockIndex);

                if (kind === 'json-tool') {
                  yield { type: 'text-delta', delta: delta.toolUse.input };
                } else {
                  yield {
                    type: 'tool_call_delta',
                    index: contentBlockIndex,
                    argumentsDelta: delta.toolUse.input,
                  } satisfies WireStreamChunk;
                }
              }
            } else if ('metadata' in event && event.metadata.usage) {
              yield {
                type: 'usage',
                usage: {
                  prompt_tokens: event.metadata.usage.inputTokens,
                  completion_tokens: event.metadata.usage.outputTokens,
                  total_tokens: event.metadata.usage.totalTokens,
                },
              };
            }
          }
        },
      },
    },
  };
}

/** Maps VernLLM's OpenAI-shaped wire `tool_choice` onto Converse's `toolChoice`. */
function toBedrockToolChoice(
  toolChoice: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
): NonNullable<Parameters<BedrockConverseClient['converse']>[0]['toolConfig']>['toolChoice'] {
  if (!toolChoice || toolChoice === 'auto') return { auto: {} };
  if (toolChoice === 'required') return { any: {} };

  if (toolChoice === 'none') {
    // Converse's toolConfig.toolChoice has no 'none' option. The only way
    // to guarantee no tool use is to omit toolConfig.tools entirely, which
    // isn't an option here since tools were explicitly requested. Silently
    // falling back to 'auto' would let the model call tools despite the
    // caller explicitly asking it not to, so this fails loudly instead.
    throw new LLMError(
      "'none' is not supported by fromBedrock: Bedrock Converse has no " +
        '`tool_choice` equivalent to forbidding tool use while tools are still offered. Omit ' +
        '`tools` entirely for this call instead.',
      'validation',
    );
  }

  return { tool: { name: toolChoice.function.name } };
}
/**
 * Translates one VernLLM wire message into Converse's
 * `{ role: 'user' | 'assistant', content }` shape.
 */
function toBedrockMessage(
  m: Extract<
    Parameters<LLMClient['chat']['completions']['create']>[0]['messages'][number],
    { role: 'user' | 'assistant' | 'tool' }
  >,
): { role: 'user' | 'assistant'; content: BedrockContentBlock[] } {
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

  if (m.role === 'assistant' && m.tool_calls?.length) {
    const blocks: BedrockContentBlock[] = [];

    if (m.content) blocks.push({ text: m.content });

    for (const tc of m.tool_calls) {
      let input: unknown;

      if (!tc.function.arguments.trim()) {
        input = {};
      } else {
        try {
          input = JSON.parse(tc.function.arguments);
        } catch (cause) {
          throw new LLMError(
            `Assistant tool call "${tc.function.name}" (${tc.id}) has arguments that are not valid JSON.`,
            'validation',
            undefined,
            undefined,
            cause,
          );
        }
      }

      blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input } });
    }

    return { role: 'assistant', content: blocks };
  }

  return {
    role: m.role,
    content: Array.isArray(m.content) ? toBedrockContent(m.content) : [{ text: m.content ?? '' }],
  };
}

/**
 * Converse expects the results of everything the model asked for in one
 * turn to arrive together as multiple `toolResult` content blocks on a
 * single `'user'` message, not as separate consecutive `'user'` messages.
 * The per-wire-message mapping above produces one `'user'` message per
 * VernLLM wire tool message, so when an assistant turn requested more than
 * one tool, this merges the resulting run of toolResult-only `'user'`
 * messages back into one.
 */
function mergeConsecutiveToolResults(
  messages: { role: 'user' | 'assistant'; content: BedrockContentBlock[] }[],
): { role: 'user' | 'assistant'; content: BedrockContentBlock[] }[] {
  const isToolResultOnly = (
    m: (typeof messages)[number],
  ): m is { role: 'user'; content: BedrockContentBlock[] } =>
    m.role === 'user' && m.content.length > 0 && m.content.every((b) => 'toolResult' in b);

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
