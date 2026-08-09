import { assertSupportedImageMimeType } from '../internal/imageFormat.js';
import {
  supportsNativeStructuredOutput,
  type ModelCapabilityOverride,
} from '../internal/nativeStructuredOutput.js';
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
      /**
       * Native, schema-constrained output: a separate request field from
       * `toolConfig`, so it can be sent alongside real tool calls. Only
       * built by this adapter for models covered by
       * `nativeStructuredOutputModels` (opt-in, see
       * `BedrockAdapterOptions`); other models keep getting `jsonSchema`
       * emulated as a forced single tool call via `toolConfig`, the
       * pre-existing behavior.
       *
       * Matches the real Bedrock Converse API's `outputConfig.textFormat`
       * shape exactly: the schema itself is nested one level deeper, under
       * `structure.jsonSchema`, not flat on `textFormat`, and `schema` is
       * a JSON-encoded *string*, not a parsed object, unlike every other
       * schema field this adapter builds (`toolSpec.inputSchema.json`
       * included). There is no `strict` field here, unlike `toolSpec`.
       */
      outputConfig?: {
        textFormat: {
          type: 'json_schema';
          structure: {
            jsonSchema: {
              schema: string;
              name?: string;
              description?: string;
            };
          };
        };
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
   * request shape `converse` does, returning `{ stream }`, matching
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
 * possibly-interleaved blocks, mirrored directly by VernLLM's
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
    }
  // The above are the happy-path events. Bedrock Converse streams can also
  // emit these as in-band exception events (not promise rejections), so
  // they need to be modeled and handled explicitly below, an unmatched
  // event previously fell through the if/else chain silently, either
  // truncating output or leaving the stream hanging until an unrelated
  // idle timeout fired.
  | { internalServerException: { message?: string } }
  | { modelStreamErrorException: { message?: string; originalStatusCode?: number } }
  | { validationException: { message?: string } }
  | { throttlingException: { message?: string } }
  | { serviceUnavailableException: { message?: string } };

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
   * Optional preflight check for tool-use support, needed whenever a
   * `jsonSchema` call ends up sending Converse `toolConfig` — either the
   * legacy forced-single-tool-call emulation, or real `tools` sent
   * alongside native structured output (`outputConfig`). VernLLM never
   * guesses capability from a failed call's error message (AWS's error
   * text isn't a documented, stable contract), so this is opt-in: pass
   * either a static list of tool-use-capable model IDs, or a predicate
   * function, and VernLLM will reject unsupported models with a clear
   * `LLMError('validation')` *before* dispatching the request, instead of
   * on the wire.
   *
   * Left unset (default), no preflight check runs, and a `jsonSchema` call
   * to an unsupported model surfaces Bedrock's raw `converse` error as-is.
   */
  toolUseSupportedModels?: string[] | ((modelId: string) => boolean);

  /**
   * Which models support native, schema-constrained output
   * (`outputConfig.textFormat`), independent of `toolConfig`, so it can be
   * combined with real `tools` in one request. Pass a static list of
   * model IDs (verified against Bedrock's own docs) or a predicate.
   *
   * There is no built-in default here (see `supportsNativeStructuredOutput`
   * for why). Left unset, every model uses the older forced-single-tool-
   * call emulation via `toolConfig`, and `tools` + `jsonSchema` together is
   * rejected, exactly this adapter's behavior before native support was
   * added.
   */
  nativeStructuredOutputModels?: ModelCapabilityOverride;
}

type BedrockRequest = Parameters<BedrockConverseClient['converse']>[0];

/**
 * Maps VernLLM's OpenAI-shaped wire `tools`/`tool_choice` into Converse's
 * `toolConfig` shape. Shared by the two call sites that build real
 * (non-schema-forced) tool definitions: the plain tools-only branch, and
 * the native-structured-output branch, which sends real tools alongside
 * `outputConfig` rather than instead of it.
 */
function buildBedrockToolConfig(
  tools: NonNullable<Parameters<LLMClient['chat']['completions']['create']>[0]['tools']>,
  toolChoiceParam: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
): NonNullable<BedrockRequest['toolConfig']> {
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.function.name,
        description: t.function.description,
        inputSchema: { json: t.function.parameters },
      },
    })),
    toolChoice: toBedrockToolChoice(toolChoiceParam),
  };
}

/**
 * Builds the Converse-shaped request from VernLLM's wire params, shared
 * between `create` and `createStream` so both go through identical
 * translation (system prompt, message shaping, the jsonSchema →
 * forced-single-tool mapping, and the `toolUseSupportedModels` preflight
 * check all happen exactly once).
 *
 * Returns `toolName` alongside the request: when set, the model was forced
 * to call a single synthetic tool standing in for `jsonSchema` output (the
 * legacy path, for models not covered by `nativeStructuredOutputModels`),
 * and both `create` and `createStream` need to know this so they can
 * unwrap that tool call back into plain text content instead of treating
 * it like a real tool call. On the native path (model covered by
 * `nativeStructuredOutputModels`), `toolName` is `undefined`: the
 * schema-conforming JSON already arrives as ordinary text content, nothing
 * to unwrap, and any real tool calls in `params.tools` are left for the
 * normal, non-forced tool-call handling both `create` and `createStream`
 * already do when `toolName` is unset.
 */
function buildBedrockRequest(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
  toolUseSupportedModels: BedrockAdapterOptions['toolUseSupportedModels'],
  nativeStructuredOutputModels: BedrockAdapterOptions['nativeStructuredOutputModels'],
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

  const schemaName = jsonSchema?.name.trim();

  if (jsonSchema && !schemaName) {
    throw new LLMError('json_schema.name must not be empty.', 'validation');
  }

  const isNative =
    Boolean(jsonSchema) &&
    supportsNativeStructuredOutput(params.model, nativeStructuredOutputModels);

  if (jsonSchema && params.tools?.length && !isNative) {
    throw new LLMError(
      `Bedrock model "${params.model}" is not covered by nativeStructuredOutputModels, so ` +
        '`jsonSchema` is emulated as a forced single tool call there (via `toolConfig`), which ' +
        'collides with the `tools` you also provided. Either drop `tools` or `jsonSchema` for this ' +
        "call, or pass this model in fromBedrock's `nativeStructuredOutputModels` option once " +
        "you've confirmed it supports Converse's `outputConfig.textFormat`.",
      'validation',
    );
  }

  let toolName: string | undefined;
  let jsonInstruction: string | undefined;
  let toolConfig: NonNullable<BedrockRequest['toolConfig']> | undefined;
  let outputConfig: NonNullable<BedrockRequest['outputConfig']> | undefined;

  if (jsonSchema && isNative) {
    // Native path: the schema goes in its own request field, independent
    // of toolConfig, so real tools (if any) are built exactly like the
    // tools-only branch below and sent alongside it.
    //
    // Unlike every other schema this adapter builds, the real Bedrock
    // Converse API requires `schema` here as a JSON-encoded *string*, not
    // a parsed object, nested under `structure.jsonSchema` rather than
    // flat on `textFormat`. There is no `strict` field on this path,
    // unlike `toolSpec`.
    const { schema, description } = jsonSchema;

    outputConfig = {
      textFormat: {
        type: 'json_schema',
        structure: {
          jsonSchema: { schema: JSON.stringify(schema), name: schemaName, description },
        },
      },
    };

    if (params.tools?.length) {
      toolConfig = buildBedrockToolConfig(params.tools, params.tool_choice);
    }
  } else if (jsonSchema && schemaName) {
    // Legacy path: jsonSchema alone (or with tools, on a native model —
    // see above), on a model without native support, becomes a forced
    // single tool call via toolConfig, unchanged from before this adapter
    // had a native path.
    const { schema, description, strict } = jsonSchema;

    toolName = schemaName;
    toolConfig = {
      tools: [{ toolSpec: { name: toolName, description, inputSchema: { json: schema }, strict } }],
      toolChoice: { tool: { name: toolName } },
    };
  } else if (params.response_format?.type === 'json_object') {
    // No schema to build a tool from, fall back to a prompt instruction.
    // This does not exclude real `tools`: `json_object` mode is just a
    // system-prompt nudge, not a request field that could collide with
    // `toolConfig`, so both are set independently below.
    jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
  }

  if (!jsonSchema && params.tools?.length) {
    toolConfig = buildBedrockToolConfig(params.tools, params.tool_choice);
  }

  // Runs whenever a jsonSchema call actually ends up sending toolConfig,
  // whether that's the legacy forced-single-tool-call path, or the native
  // path with real `tools` also present (native structured output doesn't
  // need Converse tool-use support, but real tools alongside it still do).
  if (jsonSchema && toolConfig && toolUseSupportedModels) {
    const isSupported = Array.isArray(toolUseSupportedModels)
      ? toolUseSupportedModels.includes(params.model)
      : toolUseSupportedModels(params.model);

    if (!isSupported) {
      throw new LLMError(
        `Bedrock model "${params.model}" is not listed in toolUseSupportedModels, but this call ` +
          'requires Converse tool use (either jsonSchema emulated as a forced tool call, or real ' +
          '`tools` sent alongside native structured output).',
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
    ...(outputConfig ? { outputConfig } : {}),
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
 * `response_format: json_schema`, on a model covered by
 * `options.nativeStructuredOutputModels` (opt-in, unset by default), is
 * sent as `outputConfig.textFormat`, its own request field, independent of
 * `toolConfig`, so it can be combined with real, caller-supplied `tools`
 * in the same request. Matches the real Converse API's shape exactly: the
 * schema is nested under `structure.jsonSchema` and JSON-encoded as a
 * string, not the parsed object `toolConfig`'s tool schemas use, and there
 * is no `strict` field on this path.
 *
 * On any other model (the default), `response_format: json_schema` is
 * mapped to Converse's `toolConfig` instead: a single tool is defined from
 * the schema, description, and strictness settings, and `toolChoice`
 * forces the model to call it. This legacy path cannot be combined with
 * real `tools` (both would need the same `toolConfig`), and a call that
 * tries throws `LLMError('validation')` before reaching the API.
 * Provider-constrained schema matching applies only when `strict: true` is
 * forwarded and supported. Native tool support varies by model family;
 * pass `toolUseSupportedModels` to preflight-check it (see
 * `BedrockAdapterOptions`), otherwise a `jsonSchema` call to an
 * unsupported model surfaces Bedrock's raw error unchanged.
 *
 * `response_format: json_object` (no schema to build a tool from) and
 * `reasoning_effort` (no Converse equivalent) fall back to a system-prompt
 * instruction and are dropped respectively. Unlike `jsonSchema`,
 * `json_object` combines with real `tools` freely on every model: it's a
 * prompt nudge, not a request field, so there's nothing for it to collide
 * with.
 *
 * `tools` alone maps to Converse's native `toolConfig`/`toolUse`/
 * `toolResult`; `tool_choice` maps to `toolConfig.toolChoice`.
 *
 * `createStream` calls `converseStream` (optional on `BedrockConverseClient`
 *, required only if the caller sets `stream: true`) and translates its
 * `contentBlockStart`/`contentBlockDelta`/`metadata` events into
 * `WireStreamChunk`s. Content blocks are tracked by `contentBlockIndex`,
 * same as `fromAnthropic`'s block-index tracking (Converse's streaming
 * shape is structurally close to Anthropic's own, both being tool-use-aware
 * content-block streams), including the same `json-tool` unwrapping: a
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
  const nativeStructuredOutputModels = options?.nativeStructuredOutputModels;

  return {
    chat: {
      completions: {
        async create(params, requestOptions) {
          const { request, toolName } = buildBedrockRequest(
            params,
            toolUseSupportedModels,
            nativeStructuredOutputModels,
          );

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

          const { request, toolName } = buildBedrockRequest(
            params,
            toolUseSupportedModels,
            nativeStructuredOutputModels,
          );

          const { stream } = await bedrockClient.converseStream(request, requestOptions);

          const blockKinds = new Map<number, 'text' | 'tool_use' | 'json-tool'>();

          for await (const event of stream) {
            if ('contentBlockStart' in event) {
              const { contentBlockIndex, start } = event.contentBlockStart;

              if (start?.toolUse) {
                const kind = start.toolUse.name === toolName ? 'json-tool' : 'tool_use';

                blockKinds.set(contentBlockIndex, kind);

                if (kind === 'tool_use' && !toolName) {
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
              // json-schema tool in play, see the identical guard (and
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
                } else if (!toolName) {
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
            } else if ('throttlingException' in event) {
              throw new LLMError(
                event.throttlingException.message ?? 'Bedrock throttled the request mid-stream',
                'api',
                429,
              );
            } else if ('validationException' in event) {
              throw new LLMError(
                event.validationException.message ?? 'Bedrock rejected the request mid-stream',
                'validation',
              );
            } else if (
              'internalServerException' in event ||
              'serviceUnavailableException' in event ||
              'modelStreamErrorException' in event
            ) {
              const detail =
                ('internalServerException' in event && event.internalServerException.message) ||
                ('serviceUnavailableException' in event &&
                  event.serviceUnavailableException.message) ||
                ('modelStreamErrorException' in event && event.modelStreamErrorException.message) ||
                'Bedrock reported a mid-stream error';

              const status =
                ('modelStreamErrorException' in event &&
                  event.modelStreamErrorException.originalStatusCode) ||
                ('serviceUnavailableException' in event && 503) ||
                500;

              throw new LLMError(detail, 'api', status);
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
