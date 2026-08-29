import type { CallMeta } from './fallback.js';
import type { JsonSchemaSpec, SchemaLike } from './schema.js';
import type { ToolCall, ToolChoice, ToolDefinition, ToolResult } from './tools.js';
import type { UsageHooks } from './usage.js';

/**
 * Any valid JSON value: a primitive, `null`, or a JSON array/object made
 * of the same. This is what `call()` returns when `jsonMode: true`.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Content for an `assistant` turn in `history`. Accepts a string or a
 * parsed `JsonValue`, so a prior `jsonMode: true` response can be pushed
 * straight back into history. Request construction stringifies non-string
 * content before it's sent to the provider.
 */
export type AssistantContent = string | JsonValue;

/**
 * A single prior turn in a multi-turn conversation, passed via `history`.
 *
 * Supports normal user/assistant messages and tool continuations: an assistant
 * turn may include `toolCalls`, and a tool turn carries the matching
 * `toolResults`. A tool turn must immediately follow an assistant tool call
 * turn, and every requested tool call must have a result.
 */
export type ConversationTurn =
  | {
      role: 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content?: AssistantContent;
      toolCalls?: ToolCall[];
    }
  | {
      role: 'tool';
      toolResults: ToolResult[];
    };

/** A plain text segment of a multimodal `userContent` array. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * An inline image segment of a multimodal `userContent` array.
 *
 * `data` is the raw base64-encoded image bytes, with no `data:` URL prefix
 * (adapters that need a data URL, e.g. OpenAI-compatible `image_url`, build
 * it themselves from `mimeType` + `data`; adapters that need raw bytes, e.g.
 * Bedrock, decode the base64 themselves).
 */
export interface ImageBlock {
  type: 'image';
  /** Base64-encoded image bytes, no `data:` prefix */
  data: string;
  /** e.g. 'image/png', 'image/jpeg', 'image/webp', 'image/gif' */
  mimeType: string;
}

/** A single segment of multimodal `userContent`. */
export type ContentBlock = TextBlock | ImageBlock;

/**
 * Every field of a call request except the `reserveUsage`/`refundUsage`
 * hooks from `UsageHooks`. `CallParams` is this plus `UsageHooks`; the
 * `Cached*` param types below are call sites that want the request shape
 * without those two hooks (usage is metered once, at the `cachedCall`
 * level, not per-request), and use this directly instead of re-deriving
 * it with `Omit<CallParams<T>, 'reserveUsage' | 'refundUsage'>` each time.
 */
export interface LLMRequestShape<
  T = unknown,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> {
  systemPrompt?: string;

  /** Current user message, as text or multimodal content blocks. */
  userContent: string | ContentBlock[];

  /**
   * Previous conversation turns. Must alternate roles; tool turns must follow
   * assistant tool calls. Invalid history throws LLMError('invalid_params').
   */
  history?: ConversationTurn[];

  /**
   * Generation temperature. Default 0.2, not the provider's own default.
   * Pass `null` to omit `temperature` from the request entirely, so the
   * provider applies its own default instead.
   */
  temperature?: number | null;
  jsonMode?: boolean;
  maxTokens?: number;
  requestId?: string;
  signal?: AbortSignal;

  /**
   * Total time budget in ms for this whole call, across every retry and
   * every fallback target. Unlike timeoutMs, which resets on each attempt,
   * this is a single clock starting when call is invoked. The call is
   * aborted once this elapses, even mid retry or mid fallback, the same
   * way an aborted signal is today. Omit for no overall deadline, only
   * the existing per attempt timeoutMs applies.
   *
   * Only bounds getting to a final result: choosing a target, retrying,
   * and opening a stream. It does not extend to the time spent reading a
   * stream after it has opened. Use chunkIdleTimeoutMs for gaps between
   * chunks once a stream is open.
   */
  deadlineMs?: number;

  /**
   * Per-call override for the instance's `chunkIdleTimeoutMs` (max gap
   * between stream chunks once opened). Only applies when `stream: true`.
   * Useful for routes using reasoning-heavy models with documented long
   * silent gaps mid-stream. Pass 0 to disable the idle timeout for this
   * call.
   */
  chunkIdleTimeoutMs?: number;

  /** Overrides the instance model for this call. */
  model?: string;

  /**
   * Reasoning effort for supported reasoning models. Pass `null` to
   * explicitly skip an instance-level `defaultReasoningEffort` for this
   * one call (e.g. a call using a forced `toolChoice`, which Anthropic
   * rejects alongside any reasoning at all), the same way `temperature:
   * null` opts a call out of `defaultTemperature`. Omitting the field
   * entirely (`undefined`) defers to the instance default instead.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null;

  /**
   * Token budget for internal reasoning, for models with a native numeric
   * budget (Anthropic's `budget_tokens`, Gemini's `thinkingBudget`). On a
   * provider that only understands `reasoningEffort` tiers (OpenAI-
   * compatible), this is converted to the nearest tier instead of sent as
   * a raw number. When both `budgetTokens` and `reasoningEffort` are set,
   * each adapter prefers whichever field it natively understands and
   * ignores the other. See the reasoning budget docs for the conversion
   * table used in each direction. Pass `null` to explicitly skip an
   * instance-level `defaultBudgetTokens` for this one call, mirroring
   * `reasoningEffort: null` above; omitting the field entirely defers to
   * the instance default.
   */
  budgetTokens?: number | null;

  /**
   * Provider-native JSON Schema output constraint. Implies jsonMode: true.
   */
  jsonSchema?: JsonSchemaSpec;

  /**
   * Validates parsed JSON output. Failure throws LLMError('validation').
   * Implies jsonMode: true.
   */
  schema?: SchemaLike<T>;

  /**
   * Tools the model may call. When set, `call()` returns a
   * `CallWithToolsResult<T>` union instead of `T` directly. Combining with
   * `jsonSchema` is provider-dependent; see the Tool Calling docs.
   *
   * Passed as a literal array (or via `defineTool()`-wrapped entries, see
   * `types/tools.ts`), this also drives the `Tools` type parameter, which
   * narrows `CallWithToolsResult`'s `toolCalls[number].arguments` per tool.
   */
  tools?: Tools;

  /** Defaults to `'auto'` when `tools` is set. */
  toolChoice?: ToolChoice;

  /**
   * Streams the response incrementally instead of resolving once. Default:
   * false. Requires a client/adapter that implements `createStream`.
   * Retry/timeout/circuit-breaker guarantees apply only to opening the
   * stream (through the first chunk); a failure after that point rejects
   * `finalResult` directly and is not retried, since a mid-stream failure
   * isn't connection-time evidence for the circuit breaker, the attempt
   * already counted as a success once the first chunk arrived. Once the
   * stream opens successfully, `finalResult` still resolves to the same
   * validated `T`/`CallWithToolsResult<T>` shape `call()` would have
   * returned for the same params with `stream` omitted. See
   * `StreamCallResult`.
   */
  stream?: boolean;

  /**
   * Optional out-parameter for provider identity. Pass `{}` (or any object
   * with a mutable `current` property) and `call()` writes a `CallMeta`
   * into `meta.current` before returning, alongside whatever `onUsage`
   * already reports. This includes `stream: true`: the target is chosen
   * once the stream opens, which is also the point `call()` itself
   * returns `{ chunks, finalResult }`, so `meta.current` is already set
   * by then. `TokenUsage.provider`/`usedFallback` from `onUsage` reports
   * the same information asynchronously, for both streaming and
   * non-streaming calls.
   *
   * `meta.current` is only written once execution actually reaches and
   * selects a provider target. A `wrap` middleware that short-circuits
   * without calling `next()` never reaches that point, so `meta.current`
   * is left untouched; if the same holder object is reused across calls,
   * it can still hold a prior call's target.
   */
  meta?: { current?: CallMeta };
}

export interface CallParams<T = unknown, Tools extends readonly ToolDefinition[] = ToolDefinition[]>
  extends LLMRequestShape<T, Tools>, UsageHooks {}

/**
 * A `CallParams` variant where tool calling is explicitly enabled.
 *
 * Requiring `tools` to be present allows TypeScript to select the
 * tool-aware `call()` overload and return `CallWithToolsResult<T>` instead
 * of the normal `T` response type.
 */
export type ToolEnabledCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CallParams<T, Tools> & {
  tools: NonNullable<CallParams<T, Tools>['tools']>;
};

/**
 * A `CallParams` variant for tools set conditionally, e.g. `tools:
 * someCondition ? [myTool] : undefined`. Selects the `call()` overload
 * returning the honest union `T | CallWithToolsResult<T, Tools>` instead of
 * falling through to plain `T` (which is what happened before this type
 * existed, since `ToolDefinition[] | undefined` matched neither
 * `ToolEnabledCallParams` nor `ToolsDisabledCallParams`). Forces an
 * `isToolCallResult()` check before treating the result as plain
 * content. Omitting `tools` entirely still resolves to plain `T`, since
 * tools genuinely cannot have run there.
 *
 * `Tools` still can't reliably infer a literal tuple here the way
 * `ToolEnabledCallParams` does for an inline array (a ternary/variable
 * expression doesn't carry the same `const`-literal preservation), so
 * getting typed `arguments` out of a conditional-tools result also needs
 * an explicit `Tools` type argument on `isToolCallResult<Tools>()` when
 * narrowing, see its docs.
 */
export type ConditionalToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CallParams<T, Tools> & {
  tools: Tools | undefined;
};

/** Conditional tool-call parameters whose non-tool result is plain text. */
export type ConditionalStringToolCallParams<
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = ConditionalToolCallParams<string, Tools> & {
  jsonMode: false;
};

/**
 * A `CallParams` variant where tools are offered but the model is barred
 * from calling one. `toolChoice: 'none'` guarantees the response can never
 * be a `tool_calls` result, so `call()` can narrow straight to
 * `ContentResult<T>` instead of the full `CallWithToolsResult<T>` union.
 * A call site that already knows it forced `'none'` no longer needs a
 * runtime `isToolCallResult` check, or to remember that `String(result)`
 * on the wrapper object silently produces `"[object Object]"` instead of
 * throwing. The type itself rules that shape out.
 */
export type ToolsDisabledCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CallParams<T, Tools> & {
  tools: NonNullable<CallParams<T, Tools>['tools']>;
  toolChoice: 'none';
};

/**
 * `CallParams` with `jsonMode: false`. Selects the `call()` overload
 * that returns a plain `string`. `jsonSchema` is typed `never` here: a
 * truthy `jsonSchema` forces JSON parsing at runtime regardless of
 * `jsonMode` (see `RequestBuilder.build()`), so `jsonMode: false` +
 * `jsonSchema` together would otherwise still match this overload and
 * falsely promise a `string`.
 */
export type JsonModeDisabledCallParams = Omit<CallParams<unknown>, 'jsonSchema'> & {
  jsonMode: false;
  jsonSchema?: never;
};

/**
 * `CallParams` with `jsonMode: true` and no `schema`. Selects the
 * `call()` overload that returns a `JsonValue`.
 *
 * `schema` is explicitly typed `never` here, not just omitted: `CallParams<JsonValue>['schema']`
 * would be `SchemaLike<JsonValue> | undefined`, and a schema whose inferred result type is
 * itself structurally assignable to `JsonValue` (e.g. a schema for `string[]` or
 * `Record<string, string>`) would still satisfy that shape, incorrectly selecting this
 * overload over the schema-aware generic one and widening the result to `JsonValue`. Forcing
 * `schema?: never` makes any call that sets `schema` fail this overload's structural check
 * regardless of the schema's result type, so it always falls through to the generic
 * `CallParams<T>` overload and infers `T` from the schema instead.
 */
export type JsonModeEnabledCallParams = Omit<CallParams<JsonValue>, 'schema'> & {
  jsonMode: true;
  schema?: never;
};

/** Shared cache-configuration fields, minus the internal `fn` primitive. */
export interface CachedCallInput extends UsageHooks {
  cacheKey: string;
  ttl: number;
  signal?: AbortSignal;
}

/**
 * Parameters for a cached LLM call without tool calling: cache config
 * plus the `CallParams` passed to `call()`. `reserveUsage`/`refundUsage`
 * belong at the top level (`CachedCallInput`), not nested in `call`; see
 * the caching docs for why.
 */
export type CachedCallParams<T> = CachedCallInput & {
  call: LLMRequestShape<T>;
};

/**
 * Parameters for a cached LLM call with tool calling enabled.
 *
 * The cached value includes the full `CallWithToolsResult<T>`, meaning
 * tool requests and normal content responses are cached exactly as returned
 * by the model.
 *
 * See `CachedCallParams` for why `reserveUsage`/`refundUsage` are omitted
 * from `call`'s type here too.
 */
export type CachedToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedCallInput & {
  call: LLMRequestShape<T, Tools> & {
    tools: NonNullable<LLMRequestShape<T, Tools>['tools']>;
  };
};

/**
 * Parameters for a cached LLM call with `call.tools` set conditionally.
 * Selects the `cachedCall()` overload that returns the honest union
 * `T | CallWithToolsResult<T>` instead of narrowing to plain `T`. See
 * `ConditionalToolCallParams` for why this overload exists.
 */
export type CachedConditionalToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedCallInput & {
  call: LLMRequestShape<T, Tools> & { tools: Tools | undefined };
};

/** Cached conditional tool-call parameters whose non-tool result is plain text. */
export type CachedConditionalStringToolCallParams<
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedConditionalToolCallParams<string, Tools> & {
  call: { jsonMode: false };
};

/**
 * Parameters for a cached LLM call with `jsonMode: false`. Selects the
 * `cachedCall()` overload that returns a plain `string`.
 */
export type CachedJsonModeDisabledCallParams = CachedCallInput & {
  call: Omit<LLMRequestShape<unknown>, 'jsonSchema'> & {
    jsonMode: false;
    jsonSchema?: never;
  };
};

/**
 * Parameters for a cached LLM call with `jsonMode: true` and no `schema`.
 * Selects the `cachedCall()` overload that returns a `JsonValue`.
 */
export type CachedJsonModeEnabledCallParams = CachedCallInput & {
  call: Omit<LLMRequestShape<JsonValue>, 'schema'> & {
    jsonMode: true;
    schema?: never;
  };
};
