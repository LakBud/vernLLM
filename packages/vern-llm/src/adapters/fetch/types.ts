import type { ProviderRateLimitHint } from '../../internal/utils/rate-limit/rateLimitHint.utils.js';
import type { LLMClient, WireStreamChunk } from '../../types/index.js';

/** The chat-completion-shaped request VernLLM builds internally */
export type ChatRequest = Parameters<LLMClient['chat']['completions']['create']>[0];

/**
 * The minimal response shape `fromFetch` reads. Native `fetch`'s `Response`
 * satisfies it, as do thin wrappers around `axios`, `node-fetch` or `undici`.
 */
export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** A fetch-compatible request function; defaults to native `fetch` */
export type RequestLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<ResponseLike>;

/**
 * A streaming request function: resolves to the response body as an
 * `AsyncIterable` of `Uint8Array` or `string` chunks. Defaults to native
 * `fetch`.
 */
export type StreamRequestLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<AsyncIterable<Uint8Array | string>>;

export interface FetchAdapterConfig {
  /** Endpoint URL, or a function of the request in case it depends on model/params */
  url: string | ((params: ChatRequest) => string);
  /** Static headers, or a function (sync or async) for things like refreshed auth tokens */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /** HTTP method. Default 'POST' */
  method?: string;
  /**
   * The provider behind `url`, in the OpenTelemetry `gen_ai.provider.name`
   * vocabulary, reported on `AttemptContext.adapter`. Left unset when omitted.
   */
  provider?: string;
  /** The HTTP transport. Defaults to native `fetch`. */
  request?: RequestLike;
  /** Maps VernLLMs internal chat-completion request into the providers raw request body */
  mapRequest: (params: ChatRequest) => unknown;
  /**
   * Maps the provider's JSON response. `content` may be empty when the model
   * only called tools. Each tool call's `arguments` is the JSON-encoded
   * string, as on OpenAI's wire; VernLLM parses and validates it.
   */
  mapResponse: (json: unknown) => {
    content?: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  };
  /**
   * The streaming transport. Defaults to native `fetch`, and is required for
   * `stream: true` when `request` is set, since it never falls back to it.
   */
  requestStream?: StreamRequestLike;
  /**
   * Splits the raw stream bytes into events. Defaults to Server-Sent Events
   * framing (`parseSseStream`).
   */
  parseStreamFrames?: (chunks: AsyncIterable<Uint8Array | string>) => AsyncIterable<unknown>;
  /**
   * Maps one parsed stream event into zero or more chunks; `undefined` skips
   * it. Required for `stream: true`.
   */
  mapStreamEvent?: (event: unknown) => WireStreamChunk | WireStreamChunk[] | undefined;
  /**
   * Reads AIMD's proactive rate limit hint off a successful response.
   * Defaults to OpenAI's header set.
   */
  parseRateLimitHint?: (headers: ResponseLike['headers']) => ProviderRateLimitHint;
}
