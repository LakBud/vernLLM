import type { CachedCallInput, CallParams, ToolEnabledCallParams } from './call.js';
import type { TokenUsage } from './usage.js';

/** One incremental unit of a streaming response, as delivered to the caller. */
export type StreamChunk =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; usage: TokenUsage };

/**
 * What `call()` returns when `stream: true`. `chunks` is for live rendering;
 * `finalResult` resolves to *exactly* what `call()` would have returned had
 * `stream` been omitted — same T, same `CallWithToolsResult<T>`, same
 * validation, same errors. This mirrors the non-streaming return type on
 * purpose: streaming changes delivery, not the contract.
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
 * implementation emits — analogous to how `WireMessage`/`WireToolCall`
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
    }
  | {
      type: 'usage';
      usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

/**
 * Parameters for a cached, streaming LLM call without tool calling.
 *
 * The cached value is `T` — same as `CachedCallParams<T>` — but a miss
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
 * The cached value is the full `CallWithToolsResult<T>` — same as
 * `CachedToolCallParams<T>` — with the same live-chunks-on-miss,
 * replayed-chunks-on-hit behavior as `CachedStreamCallParams<T>`.
 */
export type CachedStreamToolCallParams<T> = CachedCallInput & {
  call: StreamEnabledCallParams<T> & ToolEnabledCallParams<T>;
};
