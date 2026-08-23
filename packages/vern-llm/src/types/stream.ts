import type {
  CachedCallInput,
  CallParams,
  ConditionalToolCallParams,
  JsonValue,
  ToolEnabledCallParams,
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
       * True when `argsDelta` is the whole set of arguments, not a
       * fragment. Set for Gemini (its API returns function-call args
       * whole in one chunk) and for cache/replay chunks, which are
       * one-shot too. Omitted or `false` for a genuine fragment from
       * providers that do stream incrementally (OpenAI-compatible,
       * Anthropic, Bedrock).
       */
      complete?: boolean;
    }
  | { type: 'usage'; usage: TokenUsage };

/**
 * What `call()` returns when `stream: true`. `finalResult` resolves to
 * the same shape `call()` would have returned with `stream` omitted.
 * `chunks` is single-use and buffered; see the streaming docs for the
 * full consumption/backpressure semantics.
 */
export interface StreamCallResult<R> {
  chunks: AsyncIterable<StreamChunk>;
  finalResult: Promise<R>;
}

/**
 * A `CallParams` variant where streaming is explicitly enabled.
 *
 * Requiring `stream: true` to be statically present allows TypeScript to
 * select the streaming `call()` overload and return `StreamCallResult<...>`
 * instead of the normal, single-shot response type.
 */
export type StreamEnabledCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CallParams<T, Tools> & { stream: true };

/**
 * `StreamEnabledCallParams` with `jsonMode: false`. Selects the streaming
 * `call()` overload whose `finalResult` resolves to a plain `string`.
 * `jsonSchema` is typed `never` for the same reason as
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
 * `StreamEnabledCallParams` with `jsonMode: true` and no `schema`. Selects
 * the streaming `call()` overload whose `finalResult` resolves to a
 * `JsonValue`.
 *
 * `schema` is explicitly `never` here for the same reason as
 * `JsonModeEnabledCallParams`: a schema whose result type is itself
 * structurally assignable to `JsonValue` would otherwise still satisfy this
 * overload's shape and incorrectly widen the result to `JsonValue` instead
 * of the schema's real type.
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
      };
    }
  | {
      /**
       * A provider keep-alive signal with no content of its own (e.g.
       * Anthropic's `ping` events, an SSE comment-line heartbeat).
       * Adapters yield this so the stream loop resets its idle timeout.
       * Never surfaced to callers as a `StreamChunk`.
       */
      type: 'ping';
    };

/**
 * Parameters for a cached, streaming LLM call without tool calling.
 *
 * The cached value is `T`, same as `CachedCallParams<T>`, but a miss
 * relays live `chunks` to the caller while the result is being generated,
 * and a hit synthesizes a one-shot `chunks` replay from the cached value
 * (see `VernLLM.cachedCall`'s docs for exactly what that replay looks
 * like).
 *
 * `reserveUsage`/`refundUsage` are omitted from `call`'s type; see
 * `CachedCallParams` for why — they belong at the top level here too.
 */
export type CachedStreamCallParams<T> = CachedCallInput & {
  call: Omit<StreamEnabledCallParams<T>, 'reserveUsage' | 'refundUsage'>;
};

/**
 * Parameters for a cached, streaming LLM call with tool calling enabled.
 *
 * The cached value is the full `CallWithToolsResult<T>`, same as
 * `CachedToolCallParams<T>`, with the same live-chunks-on-miss,
 * replayed-chunks-on-hit behavior as `CachedStreamCallParams<T>`.
 */
export type CachedStreamToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedCallInput & {
  call: Omit<
    StreamEnabledCallParams<T, Tools> & ToolEnabledCallParams<T, Tools>,
    'reserveUsage' | 'refundUsage'
  >;
};

/**
 * Parameters for a cached, streaming LLM call with `call.tools` set
 * conditionally. Selects the `cachedCall()` overload whose `finalResult`
 * (on a miss) or cached value (on a hit) is the honest union
 * `T | CallWithToolsResult<T>` instead of narrowing to plain `T`. See
 * `ConditionalToolCallParams` for why this overload exists.
 */
export type CachedStreamConditionalToolCallParams<
  T,
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = CachedCallInput & {
  call: Omit<
    StreamEnabledCallParams<T, Tools> & ConditionalToolCallParams<T, Tools>,
    'reserveUsage' | 'refundUsage'
  >;
};

/**
 * Parameters for a cached, streaming LLM call with `jsonMode: false`.
 * Selects the `cachedCall()` overload whose `finalResult` (on a miss) or
 * cached value (on a hit) is a plain `string`.
 */
export type CachedStreamJsonModeDisabledCallParams = CachedCallInput & {
  call: Omit<StreamJsonModeDisabledCallParams, 'reserveUsage' | 'refundUsage'>;
};

/**
 * Parameters for a cached, streaming LLM call with `jsonMode: true` and no
 * `schema`. Selects the `cachedCall()` overload whose `finalResult` (on a
 * miss) or cached value (on a hit) is a `JsonValue`.
 */
export type CachedStreamJsonModeEnabledCallParams = CachedCallInput & {
  call: Omit<StreamJsonModeEnabledCallParams, 'reserveUsage' | 'refundUsage'>;
};
