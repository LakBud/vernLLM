import {
  LLMError,
  type ContentBlock,
  type LLMClient,
  type WireStreamChunk,
  type WireToolCall,
} from '../types/index.js';
import { assertSupportedImageMimeType } from './internal/imageFormat.js';
import {
  supportsNativeStructuredOutput,
  type ModelCapabilityOverride,
} from './internal/nativeStructuredOutput.js';
import {
  assertNoForcedToolChoiceWithThinking,
  assertValidClaudeBudgetTokens,
  budgetTokensToEffort,
  effortToBudgetTokens,
  resolveEffortTokenTable,
  supportsManualThinkingBudget,
  toClaudeAdaptiveEffort,
  type ClaudeAdaptiveEffort,
  type EffortTokenTable,
} from './internal/reasoningBudget.utils.js';

/**
 * Default heuristic for whether a Bedrock model id is a Claude model,
 * matching AWS's own `anthropic.claude-*`/`us.anthropic.claude-*` naming.
 * Only used to decide whether a reasoning token budget is worth forwarding
 * through `additionalModelRequestFields`, not a general capability check,
 * so a plain substring match is enough, no override hook needed the way
 * `nativeStructuredOutputModels`/`toolUseSupportedModels` have one: a
 * false positive here just sends an inert extra field, not a request that
 * fails outright.
 */
function isClaudeModel(model: string): boolean {
  return model.includes('claude');
}

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
        textFormat?: {
          type: 'json_schema';
          structure: {
            jsonSchema: {
              schema: string;
              name?: string;
              description?: string;
            };
          };
        };
        /**
         * Effort control for adaptive thinking, on Claude models where
         * manual `budget_tokens` thinking is no longer accepted (see
         * `supportsManualThinkingBudget` in
         * `adapters/internal/reasoningBudget.utils.ts`). Sibling to
         * `textFormat`, either or both may be present independently.
         */
        effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      };
      /**
       * Model-specific passthrough. Converse has no reasoning-budget field
       * of its own, so a token budget for a Claude model on Bedrock is
       * forwarded here under Anthropic's own key, `{ thinking: { type:
       * 'enabled', budget_tokens } }`. Non-Claude models get nothing here,
       * there is no equivalent field to reach for.
       */
      additionalModelRequestFields?: Record<string, unknown>;
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

  /**
   * Overrides the token count `reasoningEffort` tiers map onto when the
   * caller sets `reasoningEffort` but not `budgetTokens` (Converse has no
   * tier string of its own, see `adapters/internal/reasoningBudget.utils.ts`).
   * Only the tiers listed are changed; any omitted tier keeps the
   * built-in default. Has no effect when `budgetTokens` is set directly,
   * or when the target model isn't a Claude model.
   */
  reasoningEffortTokens?: Partial<EffortTokenTable>;
  /**
   * Marks additional models as adaptive-only, on top of this package's
   * own built-in rule (Claude Opus 4.7 and later, every Claude 5 tier
   * model, see `isAdaptiveOnlyModel` in
   * `adapters/internal/reasoningBudget.utils.ts`). Additive, not a
   * replacement: it can correct a false negative (a newer model this
   * package doesn't know about yet), it can't un-mark a model the
   * built-in rule already caught. Pass a static list of model IDs or a
   * predicate.
   */
  adaptiveOnlyModels?: ModelCapabilityOverride;
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
  effortTokenTable?: EffortTokenTable,
  adaptiveOnlyModels?: ModelCapabilityOverride,
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

  if (params.response_format?.type === 'json_object') {
    throw new LLMError(
      'response_format: "json_object" is not supported on Bedrock. Converse has no field that ' +
        'mechanically guarantees valid JSON output for this mode, so it used to be emulated by ' +
        'injecting a "respond with JSON only" instruction into the system prompt, a guarantee ' +
        'this adapter can no longer make. Use `jsonSchema` instead, which maps to a real ' +
        "constraint (Converse's native outputConfig.textFormat on covered models, or a forced " +
        'tool call otherwise).',
      'validation',
    );
  }

  let toolName: string | undefined;
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
  } else if (jsonSchema && schemaName) {
    // Legacy path: jsonSchema alone (or with tools, on a native model;
    // see above), on a model without native support, becomes a forced
    // single tool call via toolConfig, unchanged from before this adapter
    // had a native path.
    const { schema, description, strict } = jsonSchema;

    toolName = schemaName;
    toolConfig = {
      tools: [{ toolSpec: { name: toolName, description, inputSchema: { json: schema }, strict } }],
      toolChoice: { tool: { name: toolName } },
    };
  }

  // Runs after the branch chain, unified across every case that still
  // wants real tools built: the native-with-tools case above (toolConfig
  // still unset there, only outputConfig is), and the no-jsonSchema-at-all
  // case. `toolName` is the one signal that distinguishes them from the
  // legacy forced-single-tool-call branch, which builds its own toolConfig
  // inline and must not be overwritten here.
  if (params.tools?.length && !toolName) {
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
        'invalid_params',
        { code: 'unsupported_capability', issues: { capability: 'toolUseSupportedModels' } },
      );
    }
  }

  // Converse has no reasoning-budget field of its own; both `thinking`
  // shapes below are forwarded through `additionalModelRequestFields`,
  // passed straight through to the underlying model unchanged, and
  // meaningless to any non-Claude model family, hence the `isClaudeModel`
  // gate. Within Claude models, `budget_tokens` (manual thinking) returns
  // a 400 on Claude Opus 4.7 and later and every Claude 5 tier model, see
  // `supportsManualThinkingBudget`'s docs, so those get adaptive thinking
  // plus `outputConfig.effort` instead, same fallback `fromAnthropic`
  // uses. Native `budget_tokens`/`reasoning_effort` are each used
  // directly when the model natively accepts them; the other is
  // converted through the same table the other adapters share.
  let additionalModelRequestFields: BedrockRequest['additionalModelRequestFields'];
  let effort: ClaudeAdaptiveEffort | undefined;

  if (
    isClaudeModel(params.model) &&
    (params.budget_tokens !== undefined || params.reasoning_effort !== undefined)
  ) {
    // Checked once here, right before any thinking block is built, so a
    // caller who set budgetTokens/reasoningEffort alongside a forced
    // toolChoice (or a jsonSchema call that silently forces one to emulate
    // structured output on a non-native model, see toolConfig above) gets
    // a clear local error instead of a 400 after a real network round
    // trip. Same underlying Claude-model constraint as the Anthropic
    // adapter's own check, just against Converse's toolChoice shape
    // instead of the Anthropic SDK's.
    const forcedToolChoice = toolConfig?.toolChoice;
    assertNoForcedToolChoiceWithThinking(
      forcedToolChoice && 'tool' in forcedToolChoice
        ? `toolChoice forcing the "${forcedToolChoice.tool?.name}" tool`
        : forcedToolChoice && 'any' in forcedToolChoice
          ? "toolChoice: 'required' (Converse's \"any\" tool_choice)"
          : undefined,
    );

    if (supportsManualThinkingBudget(params.model, adaptiveOnlyModels)) {
      const budgetTokens =
        params.budget_tokens ?? effortToBudgetTokens(params.reasoning_effort!, effortTokenTable);

      // Same constraint as the Claude API itself: `budget_tokens` must be
      // at least 1024 and strictly less than `max_tokens`.
      assertValidClaudeBudgetTokens(budgetTokens, params.max_tokens);

      additionalModelRequestFields = { thinking: { type: 'enabled', budget_tokens: budgetTokens } };
    } else {
      const effortTier =
        params.reasoning_effort ?? budgetTokensToEffort(params.budget_tokens!, effortTokenTable);

      additionalModelRequestFields = { thinking: { type: 'adaptive' } };
      effort = toClaudeAdaptiveEffort(effortTier);
    }
  }

  // Same constraint as the Claude API itself: temperature (and top_p/
  // top_k) must not be sent alongside any thinking mode, manual or
  // adaptive. See the matching comment in `adapters/anthropic.ts`.
  const temperature = additionalModelRequestFields ? undefined : params.temperature;

  const request: BedrockRequest = {
    modelId: params.model,
    messages: mergeConsecutiveToolResults(conversationMessages.map((m) => toBedrockMessage(m))),
    system: systemMessage?.content ? [{ text: systemMessage.content }] : undefined,
    inferenceConfig: {
      ...(temperature !== undefined ? { temperature } : {}),
      maxTokens: params.max_tokens,
    },
    ...(toolConfig ? { toolConfig } : {}),
    ...(outputConfig || effort
      ? {
          outputConfig: {
            ...(outputConfig ?? {}),
            ...(effort ? { effort } : {}),
          },
        }
      : {}),
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  };

  return { request, toolName };
}

/**
 * Minimal structural shape of an AWS SDK v3 client that exposes `.send()`,
 * matching `BedrockRuntimeClient` (and its abort-signal-aware call
 * convention). Avoids importing `@aws-sdk/client-bedrock-runtime` for the
 * type.
 */
interface AwsSendClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/**
 * Distinguishes a real AWS SDK v3 client (`.send(command)`) from a
 * hand-written `BedrockConverseClient` (`.converse(params)`) purely
 * structurally, so `fromBedrock` can accept either without the caller
 * saying which one they're passing. The two shapes don't overlap: nothing
 * implementing `.converse()` would also need `.send()`.
 */
function isAwsSendClient(client: BedrockConverseClient | AwsSendClient): client is AwsSendClient {
  return typeof (client as AwsSendClient).send === 'function';
}

/**
 * One raw event off an AWS SDK `ConverseStreamCommand` response's `stream`.
 * Intentionally untyped (`Record<string, unknown>`, not AWS's own generated
 * `ConverseStreamOutput`). Importing that type would mean importing
 * `@aws-sdk/client-bedrock-runtime` statically, which `wrapAwsSendClient`
 * avoids. Narrowing the raw event structurally, via
 * `normalizeBedrockStreamEvent` below, gets the same safety without the
 * static dependency.
 */
type RawBedrockStreamEvent = Record<string, unknown>;

/**
 * Narrows one raw AWS stream event down to VernLLM's intentionally minimal
 * `BedrockConverseStreamEvent` union. Returns `undefined` if the event
 * isn't one of the kinds this adapter models.
 *
 * AWS's real `ConverseStreamOutput` type is a strictly larger union than
 * `BedrockConverseStreamEvent`. On top of every member modeled here, it
 * also includes a generated `$unknown` member, AWS's forward-compatibility
 * escape hatch for event kinds added to the service after this SDK version
 * was generated. A blind type assertion from one union to the other would
 * compile, but would let `$unknown` (or any other future member) reach
 * `fromBedrock`'s event-handling loop unnarrowed, as if it were one of the
 * kinds actually handled there.
 *
 * Returning `undefined` for anything unrecognized, filtered out by
 * `normalizeBedrockEventStream` below, keeps two guarantees. AWS SDK
 * generated types never leak into `fromBedrock`'s application code, only
 * this module's own `BedrockConverseStreamEvent` shape does. An event kind
 * this adapter doesn't yet know about is silently skipped, the same
 * forward-compatible behavior AWS's own `$unknown` convention implies,
 * rather than crashing the stream or being misrouted into a handler that
 * doesn't actually match its shape.
 */
function normalizeBedrockStreamEvent(
  raw: RawBedrockStreamEvent,
): BedrockConverseStreamEvent | undefined {
  if ('messageStart' in raw) return { messageStart: raw.messageStart as { role: 'assistant' } };

  if ('contentBlockStart' in raw) {
    return {
      contentBlockStart: raw.contentBlockStart as BedrockConverseStreamEvent extends {
        contentBlockStart: infer T;
      }
        ? T
        : never,
    };
  }

  if ('contentBlockDelta' in raw) {
    return {
      contentBlockDelta: raw.contentBlockDelta as BedrockConverseStreamEvent extends {
        contentBlockDelta: infer T;
      }
        ? T
        : never,
    };
  }

  if ('contentBlockStop' in raw) {
    return { contentBlockStop: raw.contentBlockStop as { contentBlockIndex: number } };
  }

  if ('messageStop' in raw) return { messageStop: raw.messageStop as { stopReason?: string } };

  if ('metadata' in raw) {
    return {
      metadata: raw.metadata as {
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      },
    };
  }

  if ('internalServerException' in raw) {
    return { internalServerException: raw.internalServerException as { message?: string } };
  }

  if ('modelStreamErrorException' in raw) {
    return {
      modelStreamErrorException: raw.modelStreamErrorException as {
        message?: string;
        originalStatusCode?: number;
      },
    };
  }

  if ('validationException' in raw) {
    return { validationException: raw.validationException as { message?: string } };
  }

  if ('throttlingException' in raw) {
    return { throttlingException: raw.throttlingException as { message?: string } };
  }

  if ('serviceUnavailableException' in raw) {
    return { serviceUnavailableException: raw.serviceUnavailableException as { message?: string } };
  }

  // Everything else, including AWS's generated `$unknown` member (and any
  // event kind added to the real service after this adapter was written),
  // is intentionally dropped here rather than forwarded.
  return undefined;
}

/**
 * Wraps a raw AWS event stream, narrowing each event through
 * `normalizeBedrockStreamEvent` and filtering out anything that doesn't
 * map onto `BedrockConverseStreamEvent`. `fromBedrock`'s event loop only
 * ever sees the shapes it actually models.
 */
async function* normalizeBedrockEventStream(
  rawStream: AsyncIterable<RawBedrockStreamEvent>,
): AsyncGenerator<BedrockConverseStreamEvent> {
  for await (const raw of rawStream) {
    const event = normalizeBedrockStreamEvent(raw);

    if (event) yield event;
  }
}

/**
 * Adapts a real AWS SDK v3 client (anything with `.send()`, matching
 * `BedrockRuntimeClient`) into a `BedrockConverseClient`, so `fromBedrock`
 * can accept either without a hand-written `.converse()`/`.converseStream()`
 * wrapper. Internally does what that wrapper would: `client.send(new
 * ConverseCommand(params))`, `client.send(new
 * ConverseStreamCommand(params))`.
 *
 * `@aws-sdk/client-bedrock-runtime` is intentionally not a dependency (not
 * even a peer dependency) of this package. `vern-llm` otherwise has zero
 * runtime dependencies, and every other adapter works the same way:
 * structural typing over whatever client the caller already has. Instead,
 * `ConverseCommand`/`ConverseStreamCommand` are pulled in with a dynamic
 * `import()` the first time either method actually runs, and memoized
 * after that. Nothing is added to `package.json`, static or peer.
 * Bundlers only pull the AWS SDK in for code paths that actually pass a
 * raw AWS client to `fromBedrock`; a hand-written `BedrockConverseClient`
 * stays unaffected. If `@aws-sdk/client-bedrock-runtime` isn't installed,
 * the failure is a clear `LLMError` naming exactly what's missing, at the
 * moment it's needed, rather than a silent peer-dependency warning at
 * install time or a raw "Cannot find module" a caller has to trace back
 * themselves.
 *
 * Also closes two structural gaps between AWS's generated types and
 * `BedrockConverseClient`. AWS's `ConverseStreamCommandOutput.stream` is
 * optional, a response may not include it. This throws a clear `LLMError`
 * instead of letting `undefined` reach `fromBedrock`'s `for await` loop.
 * AWS's `ConverseStreamOutput` union is larger than
 * `BedrockConverseStreamEvent`, it includes a generated `$unknown` member.
 * Every event is narrowed through `normalizeBedrockStreamEvent` before it
 * reaches application code, instead of being asserted wholesale from one
 * type to the other.
 */
function wrapAwsSendClient(client: AwsSendClient): BedrockConverseClient {
  type BedrockRuntimeCommands = {
    ConverseCommand: new (input: unknown) => unknown;
    ConverseStreamCommand: new (input: unknown) => unknown;
  };

  let commandsPromise: Promise<BedrockRuntimeCommands> | undefined;

  function loadCommands(): Promise<BedrockRuntimeCommands> {
    commandsPromise ??= import('@aws-sdk/client-bedrock-runtime').then(
      (mod) => mod as BedrockRuntimeCommands,
      (cause) => {
        commandsPromise = undefined;

        throw new LLMError(
          'fromBedrock requires "@aws-sdk/client-bedrock-runtime" to be installed to use a raw AWS ' +
            'SDK client (it is not a dependency of vern-llm itself). Install it, or pass your own ' +
            'object with .converse()/.converseStream() methods instead.',
          'validation',
          { cause },
        );
      },
    );

    return commandsPromise;
  }

  return {
    converse: async (params, requestOptions) => {
      const { ConverseCommand } = await loadCommands();

      return client.send(new ConverseCommand(params), {
        abortSignal: requestOptions.signal,
      }) as ReturnType<BedrockConverseClient['converse']> extends Promise<infer R>
        ? Promise<R>
        : never;
    },

    converseStream: async (params, requestOptions) => {
      const { ConverseStreamCommand } = await loadCommands();

      const result = (await client.send(new ConverseStreamCommand(params), {
        abortSignal: requestOptions.signal,
      })) as { stream?: AsyncIterable<RawBedrockStreamEvent> };

      // AWS marks `stream` optional on `ConverseStreamCommandOutput`
      // because a response may not include it; VernLLM's own
      // `BedrockConverseClient.converseStream` return shape requires it,
      // since a `stream: true` call is meaningless without one. Fail
      // loudly here, at the adapter boundary, instead of letting
      // `undefined` reach `fromBedrock`'s `for await (const event of
      // stream)` loop, where it would throw a much less specific
      // "stream is not async iterable" error.
      if (!result.stream) {
        throw new LLMError(
          'Bedrock ConverseStreamCommand response did not include a stream. This can happen if the ' +
            "request or the model doesn't actually support Converse streaming.",
          'api',
          { code: 'server_error' },
        );
      }

      return { stream: normalizeBedrockEventStream(result.stream) };
    },
  };
}

/**
 * Wraps a Bedrock Converse-API client so it satisfies the `LLMClient`
 * interface VernLLM uses for OpenAI/Groq. The Converse API is unified
 * across Bedrock's model families (Anthropic, Titan, Llama, Mistral, etc.),
 * so unlike raw per-model Bedrock invocation, this one adapter works
 * regardless of which underlying model `modelId` points at, as long as
 * that model supports Converse (most current-generation ones do)
 *
 * `bedrockClient` accepts either a hand-written `BedrockConverseClient`
 * (a `.converse()`/`.converseStream()` wrapper you provide) or a real AWS
 * SDK v3 client (anything with `.send()`, matching `BedrockRuntimeClient`)
 * directly, detected structurally. Passing a raw AWS client skips the
 * hand-written wrapper entirely, internally doing what it would
 * (`send(new ConverseCommand(...))`, `send(new
 * ConverseStreamCommand(...))`). See `wrapAwsSendClient` for how that path
 * is implemented, including why `@aws-sdk/client-bedrock-runtime` stays
 * out of this package's dependencies either way.
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
 * `response_format: json_object` throws `LLMError('validation')`: Converse
 * has no field that mechanically guarantees JSON output, and the only way
 * to emulate it was an unenforced system-prompt instruction, a guarantee
 * this adapter no longer pretends to make. Use `jsonSchema` instead.
 * `reasoning_effort` (no Converse equivalent) is converted to a token
 * budget and forwarded via `additionalModelRequestFields` for Claude
 * models only; `budget_tokens` is forwarded the same way directly. Both
 * are silently dropped for non-Claude models, which have no equivalent
 * field to reach for. See `adapters/internal/reasoningBudget.utils.ts`.
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
  bedrockClient: BedrockConverseClient | AwsSendClient,
  options?: BedrockAdapterOptions,
): LLMClient {
  const client: BedrockConverseClient = isAwsSendClient(bedrockClient)
    ? wrapAwsSendClient(bedrockClient)
    : bedrockClient;

  const toolUseSupportedModels = options?.toolUseSupportedModels;
  const nativeStructuredOutputModels = options?.nativeStructuredOutputModels;
  const effortTokenTable = resolveEffortTokenTable(options?.reasoningEffortTokens);
  const adaptiveOnlyModels = options?.adaptiveOnlyModels;

  return {
    // json_object is not supported: see buildBedrockRequest's throw above,
    // and LLMClient.supportsJsonObjectMode's docs.
    supportsJsonObjectMode: false,
    chat: {
      completions: {
        async create(params, requestOptions) {
          const { request, toolName } = buildBedrockRequest(
            params,
            toolUseSupportedModels,
            nativeStructuredOutputModels,
            effortTokenTable,
            adaptiveOnlyModels,
          );

          const response = await client.converse(request, requestOptions);

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
          if (!client.converseStream) {
            throw new LLMError(
              'stream: true requires a Bedrock client with converseStream',
              'invalid_params',
              { code: 'unsupported_capability', issues: { capability: 'converseStream' } },
            );
          }

          const { request, toolName } = buildBedrockRequest(
            params,
            toolUseSupportedModels,
            nativeStructuredOutputModels,
            effortTokenTable,
            adaptiveOnlyModels,
          );

          const { stream } = await client.converseStream(request, requestOptions);

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
                { status: 429, code: 'provider_rate_limited' },
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

              throw new LLMError(detail, 'api', {
                status,
                code: status >= 500 ? 'server_error' : undefined,
              });
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
      'invalid_params',
      { code: 'unsupported_capability', issues: { capability: "toolChoice: 'none'" } },
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
            { cause },
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
