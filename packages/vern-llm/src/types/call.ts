import type { LLMErrorCode } from './errors.js';
import type { CallMeta } from './fallback.js';
import type { JsonSchemaSpec, SchemaLike } from './schema.js';
import type {
  ToolCall,
  ToolChoice,
  ToolDefinition,
  ToolResult,
  CallWithToolsResult,
} from './tools.js';
import type { TokenUsage, UsageHooks } from './usage.js';

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
 * Plain JSON describing the request, e.g. tenant or routing constraints. Never sent to the
 * provider.
 */
export type CallContext = { readonly [key: string]: JsonValue };

/**
 * Content for an `assistant` turn in `history`. A parsed `JsonValue` from a `jsonMode` response can
 * go straight back in; it is stringified before sending.
 */
export type AssistantContent = string | JsonValue;

/**
 * A reasoning block Claude produced before a tool call. Pass it back untouched on the assistant
 * turn that requested the tools: Claude with thinking on rejects the next call without it, and the
 * `signature` covers the text.
 */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/**
 * One prior turn in `history`. A tool turn must directly follow the assistant turn that called the
 * tools, with a result for every call.
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
      /**
       * Reasoning blocks from this turn, as `ToolCallResult.thinking`
       * returned them. Sent ahead of the text and tool calls by
       * `fromAnthropic` and `fromBedrock`; other adapters drop them.
       */
      thinking?: ThinkingBlock[];
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
 * An inline image in a multimodal `userContent` array. `data` is raw base64 with no `data:` prefix;
 * each adapter converts it as its provider needs.
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
 * Every request field except the `UsageHooks`. The `Cached*` params use it, since `cachedCall`
 * meters usage once at the top level.
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
   * Total ms budget for the whole call, across retries and fallback targets, unlike the per attempt
   * `timeoutMs`. Covers getting to a result and opening a stream, not reading one; use
   * `chunkIdleTimeoutMs` for that. Omit or pass Infinity for none.
   */
  deadlineMs?: number;

  /**
   * Per call override for the max gap between stream chunks. Only applies with `stream: true`. Pass
   * 0 to disable.
   */
  chunkIdleTimeoutMs?: number;

  /**
   * Overrides the instance model for this call. Applies to the primary
   * target only, fallback targets always run their own configured model.
   */
  model?: string;

  /**
   * Reasoning effort for supported models. `null` skips `defaultReasoningEffort` for this call, as
   * `temperature: null` does; `undefined` uses the default.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null;

  /**
   * Reasoning token budget, for providers with a numeric budget. Providers with only effort tiers
   * get the nearest tier. With both set, each adapter uses the one it understands. `null` skips
   * `defaultBudgetTokens`.
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
   * Tools the model may call. Makes `call()` return `CallWithToolsResult<T>`. A literal array also
   * types each tool's `arguments`.
   */
  tools?: Tools;

  /** Defaults to `'auto'` when `tools` is set. */
  toolChoice?: ToolChoice;

  /**
   * Streams the response. Requires an adapter with `createStream`. Retries and fallback cover the
   * stream until its first content; later failures reject `finalResult`. `finalResult` resolves to
   * the same shape a non-streaming call returns. See `StreamCallResult`.
   */
  stream?: boolean;

  /**
   * Out parameter written with the answering target's `CallMeta`, set before `call()` returns,
   * streams included. Left untouched when a `wrap` middleware short-circuits, so a reused holder
   * may keep an older value.
   */
  meta?: { current?: CallMeta };

  /** See `CallContext`. Read by middleware, events and usage. */
  context?: CallContext;
}

export interface CallParams<T = unknown, Tools extends readonly ToolDefinition[] = ToolDefinition[]>
  extends LLMRequestShape<T, Tools>, UsageHooks {}

/** `CallParams` with `tools` set, selecting the overload that returns `CallWithToolsResult<T>`. */
export type ToolEnabledCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CallParams<T, Tools> & {
  tools: NonNullable<CallParams<T, Tools>['tools']>;
};

/**
 * `CallParams` for conditionally set tools, e.g. `tools: flag ? [tool] : undefined`. Returns `T |
 * CallWithToolsResult<T, Tools>`, forcing an `isToolCallResult()` check. Typed `arguments` need an
 * explicit `Tools` argument on that check, since a ternary loses the literal tuple.
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
 * `CallParams` with `toolChoice: 'none'`. The model can't call a tool, so `call()` returns
 * `ContentResult<T>` and no `isToolCallResult` check is needed.
 */
export type ToolsDisabledCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CallParams<T, Tools> & {
  tools: NonNullable<CallParams<T, Tools>['tools']>;
  toolChoice: 'none';
};

/**
 * `CallParams` with `jsonMode: false`, returning a `string`. `jsonSchema` is `never`, since a
 * schema forces JSON parsing regardless of `jsonMode`.
 */
export type JsonModeDisabledCallParams = Omit<CallParams<unknown>, 'jsonSchema'> & {
  jsonMode: false;
  jsonSchema?: never;
};

/**
 * `CallParams` with `jsonMode: true` and no `schema`, returning `JsonValue`. `schema` is `never`
 * rather than omitted, so a schema whose output happens to fit `JsonValue` still picks the schema
 * aware overload.
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
 * A cached call without tools: cache config plus the `call` params. `reserveUsage` and
 * `refundUsage` go at the top level, not inside `call`.
 */
export type CachedCallParams<T> = CachedCallInput & {
  call: LLMRequestShape<T>;
};

/** A cached call with tools. Tool requests and content responses are cached exactly as returned. */
export type CachedToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedCallInput & {
  call: LLMRequestShape<T, Tools> & {
    tools: NonNullable<LLMRequestShape<T, Tools>['tools']>;
  };
};

/**
 * A cached call with `call.tools` set conditionally. Returns `T | CallWithToolsResult<T>`, see
 * `ConditionalToolCallParams`.
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

/** Context handed to `DetectSoftFailure` alongside the response it's inspecting. */
export interface SoftFailureMeta {
  requestId: string;
  model: string;
  providerName: string;
  isFallback: boolean;
  /** 1-based, matching `CallMeta.attempts`. */
  attempt: number;
  /**
   * Usage for this attempt, if reported. `undefined` means unknown, not zero, so treat it as such
   * in cost checks.
   */
  usage?: TokenUsage;
}

/**
 * Reclassifies an otherwise successful result. Return an `LLMErrorCode` to fail the attempt through
 * the normal retry and breaker paths, or `undefined` to keep it. Catches empty, truncated or
 * refusal answers that parse fine.
 */
export type DetectSoftFailure<T = unknown> = (
  result: T | CallWithToolsResult<T>,
  meta: SoftFailureMeta,
) => LLMErrorCode | undefined;
