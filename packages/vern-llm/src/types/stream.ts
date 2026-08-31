import type { ProviderRateLimitHint } from '../internal/utils/rateLimitHint.utils.js';
import type {
  CachedCallInput,
  CallParams,
  ConditionalStringToolCallParams,
  JsonValue,
  LLMRequestShape,
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

/** Streaming conditional tool-call parameters whose non-tool result is text. */
export type StreamConditionalStringToolCallParams<
  Tools extends readonly ToolDefinition[] = ToolDefinition[],
> = StreamEnabledCallParams<string, Tools> & ConditionalStringToolCallParams<Tools>;

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
    }
  | {
      /**
       * AIMD's proactive rate-limit hint, read off the stream's
       * response headers (where the adapter/SDK can get at them) and
       * yielded once, as early as possible. Mirrors `attachRateLimitHint`
       * for the non-streaming path, just carried as a chunk instead of a
       * hidden property on a response object, since a stream has no
       * single response value to attach one to. Never surfaced to
       * callers as a `StreamChunk`.
       */
      type: 'rate_limit_hint';
      hint: ProviderRateLimitHint;
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
 * `CachedCallParams` for why they belong at the top level here too.
 */
export type CachedStreamCallParams<T> = CachedCallInput & {
  call: LLMRequestShape<T> & { stream: true };
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
  call: LLMRequestShape<T, Tools> & {
    stream: true;
    tools: NonNullable<LLMRequestShape<T, Tools>['tools']>;
  };
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
