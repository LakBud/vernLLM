import type { CachedCallInput, CallParams, ToolEnabledCallParams } from './call.js';
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
 * What `call()` returns when `stream: true`. `chunks` is for live rendering;
 * `finalResult` resolves to the same validated `T`/`CallWithToolsResult<T>`
 * shape `call()` would have returned had `stream` been omitted, once the
 * stream completes successfully.
 *
 * `chunks` is single-use and supports only one consumer: iterating it more
 * than once, or from more than one place concurrently, shares the same
 * underlying buffered stream rather than replaying or forking it, which can
 * split chunks unpredictably between consumers. Stopping iteration early
 * (e.g. `break`ing out of a `for await`) does not cancel or otherwise
 * signal the underlying stream, the background pump keeps running to
 * completion regardless, buffering any chunks emitted after that point, so
 * `finalResult` still settles normally even if `chunks` is abandoned or
 * never read at all.
 *
 * Unread chunks are buffered internally for the duration of one stream,
 * this is what lets a caller start iterating `chunks` after the stream has
 * already progressed (or finished) and still see everything. That backlog
 * is capped: an unusually large stream whose `chunks` is never read at all
 * has its oldest buffered chunks dropped once the backlog grows past
 * roughly twice a fixed internal limit, trimmed back down to that limit in
 * one batch rather than one-at-a-time, bounding both peak memory and the
 * eviction work itself for that pathological case instead of the array
 * growing (or being trimmed) proportional to the whole stream's output.
 * Ordinary consumption, even started somewhat late, stays far under the
 * limit and is unaffected.
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
export type StreamEnabledCallParams<T> = CallParams<T> & { stream: true };

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
      usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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
 */
export type CachedStreamCallParams<T> = CachedCallInput & {
  call: StreamEnabledCallParams<T>;
};

/**
 * Parameters for a cached, streaming LLM call with tool calling enabled.
 *
 * The cached value is the full `CallWithToolsResult<T>`, same as
 * `CachedToolCallParams<T>`, with the same live-chunks-on-miss,
 * replayed-chunks-on-hit behavior as `CachedStreamCallParams<T>`.
 */
export type CachedStreamToolCallParams<T> = CachedCallInput & {
  call: StreamEnabledCallParams<T> & ToolEnabledCallParams<T>;
};
