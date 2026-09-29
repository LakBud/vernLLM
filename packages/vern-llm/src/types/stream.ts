import type { ProviderRateLimitHint } from '../internal/utils/rate-limit/rateLimitHint.utils.js';
import type {
  CachedCallInput,
  CallParams,
  ConditionalStringToolCallParams,
  JsonValue,
  LLMRequestShape,
  ThinkingBlock,
} from './call.js';
import type { ToolDefinition } from './tools.js';
import type { TokenUsage } from './usage.js';

/** One incremental unit of a streaming response, as delivered to the caller. */
export type StreamChunk =
  | { type: 'text-delta'; delta: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argsDelta?: string;
      /**
       * True when `argsDelta` holds the whole arguments rather than a fragment, as with Gemini and
       * cache replays.
       */
      complete?: boolean;
    }
  | { type: 'usage'; usage: TokenUsage };

/**
 * What `call()` returns with `stream: true`. `finalResult` resolves to the same shape a
 * non-streaming call returns. `chunks` is single use; see the streaming docs.
 */
export interface StreamCallResult<R> {
  chunks: AsyncIterable<StreamChunk>;
  finalResult: Promise<R>;
}

/** `CallParams` with `stream: true`, selecting the overload that returns `StreamCallResult`. */
export type StreamEnabledCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CallParams<T, Tools> & { stream: true };

/** Streaming conditional tool-call parameters whose non-tool result is text. */
export type StreamConditionalStringToolCallParams<
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = StreamEnabledCallParams<string, Tools> & ConditionalStringToolCallParams<Tools>;

/** Recovers `T` from a `result` already typed `T | StreamCallResult<T>`. Falls back to `unknown`. */
type ExtractStreamValue<R> =
  Extract<R, StreamCallResult<unknown>> extends StreamCallResult<infer V> ? V : unknown;

/** Minimal duck-typed `PromiseLike` check: anything with a callable `.then`. */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Minimal duck-typed `AsyncIterable` check: anything with a callable `Symbol.asyncIterator`. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Whether a `call()` result is a `StreamCallResult`. Useful when `stream` was set conditionally,
 * since the overloads only pick the streaming shape for a literal `stream: true`.
 */
export function isStreamResult<R = unknown>(
  result: R,
): result is R & StreamCallResult<ExtractStreamValue<R>> {
  if (typeof result !== 'object' || result === null) return false;

  const candidate = result as Partial<StreamCallResult<unknown>>;
  return isAsyncIterable(candidate.chunks) && isPromiseLike(candidate.finalResult);
}

/**
 * Streaming `jsonMode: false`, with `finalResult` as a `string`. `jsonSchema` is `never`, as in
 * `JsonModeDisabledCallParams`.
 */
export type StreamJsonModeDisabledCallParams = Omit<
  StreamEnabledCallParams<unknown>,
  'jsonSchema'
> & {
  jsonMode: false;
  jsonSchema?: never;
};

/**
 * Streaming `jsonMode: true` without `schema`, with `finalResult` as `JsonValue`. `schema` is
 * `never`, as in `JsonModeEnabledCallParams`.
 */
export type StreamJsonModeEnabledCallParams = Omit<StreamEnabledCallParams<JsonValue>, 'schema'> & {
  jsonMode: true;
  schema?: never;
};

/**
 * The adapter-facing, pre-normalization shape a `createStream` client
 * implementation emits, analogous to how `WireMessage`/`WireToolCall`
 * already sit between `CallParams` and each provider's own wire format.
 */
export type WireStreamChunk =
  | { type: 'text-delta'; delta: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
      /** Same meaning as `StreamChunk`'s `tool_call_delta.complete`. */
      complete?: boolean;
    }
  | {
      type: 'usage';
      usage: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
        /** Cache split of `prompt_tokens`. Follows OpenAI and OpenRouter naming. */
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
          /** Writes by TTL label, e.g. `{ '5m': 1200, '1h': 800 }`. */
          cache_write_tokens_by_ttl?: Record<string, number>;
        };
      };
    }
  | {
      /** A provider keep-alive with no content. Resets the idle timeout; never reaches callers. */
      type: 'ping';
    }
  | {
      /**
       * A rate limit hint from the stream's response headers, yielded as early as possible for
       * AIMD. The streaming counterpart of `attachRateLimitHint`. Never reaches callers.
       */
      type: 'rate_limit_hint';
      hint: ProviderRateLimitHint;
    }
  | {
      /**
       * One complete reasoning block, yielded once it has fully arrived.
       * Collected onto `ToolCallResult.thinking`, never surfaced to
       * callers as a `StreamChunk`.
       */
      type: 'thinking_block';
      block: ThinkingBlock;
    };

/**
 * A cached streaming call without tools. A miss relays live chunks; a hit replays the cached value
 * as chunks. `reserveUsage` and `refundUsage` go at the top level.
 */
export type CachedStreamCallParams<T> = CachedCallInput & {
  call: LLMRequestShape<T> & { stream: true };
};

/** A cached streaming call with tools, caching the full `CallWithToolsResult<T>`. */
export type CachedStreamToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedCallInput & {
  call: LLMRequestShape<T, Tools> & {
    stream: true;
    tools: NonNullable<LLMRequestShape<T, Tools>['tools']>;
  };
};

/**
 * A cached streaming call with `call.tools` set conditionally, resolving to `T |
 * CallWithToolsResult<T>`.
 */
export type CachedStreamConditionalToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedCallInput & {
  call: LLMRequestShape<T, Tools> & { stream: true; tools: Tools | undefined };
};

/** Cached streaming conditional tool-call parameters whose non-tool result is text. */
export type CachedStreamConditionalStringToolCallParams<
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedStreamConditionalToolCallParams<string, Tools> & {
  call: { jsonMode: false };
};

/**
 * Parameters for a cached, streaming LLM call with `jsonMode: false`.
 * Selects the `cachedCall()` overload whose `finalResult` (on a miss) or
 * cached value (on a hit) is a plain `string`.
 */
export type CachedStreamJsonModeDisabledCallParams = CachedCallInput & {
  call: Omit<LLMRequestShape<unknown>, 'jsonSchema'> & {
    stream: true;
    jsonMode: false;
    jsonSchema?: never;
  };
};

/**
 * Parameters for a cached, streaming LLM call with `jsonMode: true` and no
 * `schema`. Selects the `cachedCall()` overload whose `finalResult` (on a
 * miss) or cached value (on a hit) is a `JsonValue`.
 */
export type CachedStreamJsonModeEnabledCallParams = CachedCallInput & {
  call: Omit<LLMRequestShape<JsonValue>, 'schema'> & {
    stream: true;
    jsonMode: true;
    schema?: never;
  };
};
