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

export interface CallParams<T = unknown> extends UsageHooks {
  systemPrompt?: string;

  /** Current user message, as text or multimodal content blocks. */
  userContent: string | ContentBlock[];

  /**
   * Previous conversation turns. Must alternate roles; tool turns must follow
   * assistant tool calls. Invalid history throws LLMError('validation').
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
   * Per-call override for the instance's `chunkIdleTimeoutMs` (max gap
   * between stream chunks once opened). Only applies when `stream: true`.
   * Useful for routes using reasoning-heavy models with documented long
   * silent gaps mid-stream. Pass 0 to disable the idle timeout for this
   * call.
   */
  chunkIdleTimeoutMs?: number;

  /** Overrides the instance model for this call. */
  model?: string;

  /** Reasoning effort for supported reasoning models. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';

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
   * Tools the model may call. When set, `call()` always returns a
   * `CallWithToolsResult<T>` discriminated union instead of `T` directly
   * (see `CallWithToolsResult`), a breaking-change point: omitting `tools`
   * keeps `call()`'s old `Promise<T>` behavior exactly.
   *
   * Can be combined with `jsonSchema` on Gemini and OpenAI-compatible
   * clients unconditionally (neither ever restricted the combination:
   * Gemini builds `responseSchema`/`tools` as independent fields, OpenAI-
   * compatible clients pass both straight through). On Anthropic and
   * Bedrock, combining the two is opt-in per call site, via each
   * adapter's `nativeStructuredOutputModels` option: models not covered
   * by it still throw `LLMError('validation')`, since `jsonSchema` falls
   * back to a forced single-tool call there, which would collide with
   * real tools. See `fromAnthropic`/`fromBedrock`.
   *
   * `schema` (client-side validation, distinct from `jsonSchema`) was
   * never restricted from combining with `tools` on any provider.
   */
  tools?: ToolDefinition[];

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
   * already reports. Ignored for `stream: true`, since `call()` returns
   * before the outcome (and so the target that answered) is known; read
   * `TokenUsage.provider`/`usedFallback` from `onUsage` for streaming
   * calls instead.
   */
  meta?: { current?: CallMeta };
}

/**
 * A `CallParams` variant where tool calling is explicitly enabled.
 *
 * Requiring `tools` to be present allows TypeScript to select the
 * tool-aware `call()` overload and return `CallWithToolsResult<T>` instead
 * of the normal `T` response type.
 */
export type ToolEnabledCallParams<T> = CallParams<T> & {
  tools: NonNullable<CallParams<T>['tools']>;
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
export type ToolsDisabledCallParams<T> = CallParams<T> & {
  tools: NonNullable<CallParams<T>['tools']>;
  toolChoice: 'none';
};

/**
 * `CallParams` with `jsonMode: false`. Selects the `call()` overload
 * that returns a plain `string`.
 *
 * `jsonSchema` is explicitly typed `never` here, not just omitted:
 * `RequestBuilder.build()` treats a truthy `jsonSchema` as forcing JSON
 * parsing (`useJson = jsonModeEffective || Boolean(jsonSchema)`)
 * regardless of `jsonMode`, so a call that sets both `jsonMode: false`
 * and `jsonSchema` still gets its response parsed as JSON at runtime.
 * Forcing `jsonSchema?: never` makes any such call fail this overload's
 * structural check, so it falls through to the generic `CallParams<T>`
 * overload instead of incorrectly promising a plain `string`.
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
 * Parameters for a cached LLM call without tool calling.
 *
 * Combines the cache configuration with the `CallParams` passed to
 * `VernLLM.call()`. The cached value is the normal LLM response type `T`.
 *
 * `reserveUsage`/`refundUsage` are omitted from `call`'s type on purpose:
 * `CachedCallInput` already extends `UsageHooks`, so those two hooks
 * belong at the top level, alongside `cacheKey`/`ttl`, not nested inside
 * `call`. Both positions used to typecheck, which meant `cachedCall`
 * could only catch the mistake at runtime with a warning, after silently
 * ignoring the caller's usage hooks. Putting them inside `call` as an
 * inline object literal is now a compile error instead; TypeScript's
 * excess-property check only applies to object literals though, so a
 * preconstructed value carrying `reserveUsage`/`refundUsage` can still be
 * structurally assignable, which is why `cachedCall` also checks for and
 * rejects both hooks at runtime.
 */
export type CachedCallParams<T> = CachedCallInput & {
  call: Omit<CallParams<T>, 'reserveUsage' | 'refundUsage'>;
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
export type CachedToolCallParams<T> = CachedCallInput & {
  call: Omit<ToolEnabledCallParams<T>, 'reserveUsage' | 'refundUsage'>;
};

/**
 * Parameters for a cached LLM call with `jsonMode: false`. Selects the
 * `cachedCall()` overload that returns a plain `string`.
 */
export type CachedJsonModeDisabledCallParams = CachedCallInput & {
  call: Omit<JsonModeDisabledCallParams, 'reserveUsage' | 'refundUsage'>;
};

/**
 * Parameters for a cached LLM call with `jsonMode: true` and no `schema`.
 * Selects the `cachedCall()` overload that returns a `JsonValue`.
 */
export type CachedJsonModeEnabledCallParams = CachedCallInput & {
  call: Omit<JsonModeEnabledCallParams, 'reserveUsage' | 'refundUsage'>;
};
