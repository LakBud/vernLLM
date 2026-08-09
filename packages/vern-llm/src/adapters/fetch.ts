import { parseSseStream, SSE_PING } from '../internal/sse.js';
import {
  LLMError,
  type LLMClient,
  type WireStreamChunk,
  type WireToolCall,
} from '../types/index.js';

/** The chat-completion-shaped request VernLLM builds internally */
type ChatRequest = Parameters<LLMClient['chat']['completions']['create']>[0];

/**
 * The minimal shape the fetch adapter needs from a response object.
 * Native `fetch`'s `Response` satisfies this, but so do wrappers around
 * `axios`, `node-fetch`, `undici`, etc, which makes `request` swappable
 * without forcing consumers to polyfill the full `Response` interface
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
 * A streaming-capable request function. Unlike `RequestLike`, which returns
 * a fully-buffered `ResponseLike`, this resolves to an `AsyncIterable` of
 * progressively-arriving chunks, the common ground across transports:
 * native `fetch`'s `response.body` (wrapped to be iterable; see
 * `webStreamToAsyncIterable` below), axios's Node `Readable` in
 * `responseType: 'stream'` mode (already async-iterable, no wrapping
 * needed), `node-fetch`, `undici`, etc, all satisfy this with little or no
 * glue code. Defaults to native `fetch`.
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
   * The function used to make the HTTP request. Defaults to native `fetch`.
   * Swap in `axios`, `node-fetch`, or any other transport, as long as it
   * resolves to a `ResponseLike` object
   */
  request?: RequestLike;
  /** Maps VernLLMs internal chat-completion request into the providers raw request body */
  mapRequest: (params: ChatRequest) => unknown;
  /**
   * Maps the providers raw JSON response into `{ content, usage?, toolCalls? }`
   * `content` is the assistants text (JSON string when JSON mode was requested).
   * `content` may be empty/omitted when the model responded with only tool
   * calls and no text.
   *
   * `toolCalls`, when the model requested one or more tools, is the list of
   * calls in `WireToolCall`'s OpenAI-`function`-wrapped shape: each entry's
   * `id`/`name` plus its arguments already JSON-*encoded* as a string (not
   * the parsed object), mirroring the wire format every OpenAI-compatible
   * provider uses. VernLLM parses (and validates, if `argumentsSchema` was
   * set) that string internally, mapResponse doesn't need to do that itself.
   */
  mapResponse: (json: unknown) => {
    content?: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  };

  /**
   * Optional. Required only for `stream: true` calls. The function used to
   * open a streaming HTTP request. Takes the same request shape as
   * `request`, but resolves to an `AsyncIterable` of progressively-arriving
   * `Uint8Array` or `string` chunks instead of a buffered `ResponseLike`.
   * Defaults to native `fetch`.
   */
  requestStream?: StreamRequestLike;

  /**
   * Optional. How the raw stream bytes are split into individual event
   * payloads. Defaults to Server-Sent Events framing (`data: ...` blocks
   * separated by a blank line, `[DONE]` sentinel honored, see
   * `parseSseStream`), which covers the large majority of LLM providers'
   * streaming HTTP endpoints. Override this for a provider that frames its
   * stream differently, e.g. newline-delimited JSON (NDJSON) with no SSE
   * envelope.
   */
  parseStreamFrames?: (chunks: AsyncIterable<Uint8Array | string>) => AsyncIterable<unknown>;

  /**
   * Optional. Required only for `stream: true` calls. Maps one parsed
   * stream event (already extracted from its frame by `parseStreamFrames`)
   * into zero, one, or more `WireStreamChunk`s, mirrors `mapResponse`'s
   * role for the non-streaming path, just per-event instead of once for
   * the whole body. Return `undefined` to skip an event that carries
   * nothing VernLLM needs (e.g. a provider's keep-alive ping). Configs
   * that don't implement this make `stream: true` throw a clear
   * `LLMError('validation')` rather than a confusing runtime failure or a
   * silently empty stream.
   */
  mapStreamEvent?: (event: unknown) => WireStreamChunk | WireStreamChunk[] | undefined;
}

/**
 * Wraps a WHATWG `ReadableStream` (what `response.body` is) so it can be
 * consumed with `for await`. Implemented via `getReader()` rather than
 * relying on `ReadableStream` having a native `Symbol.asyncIterator`,
 * that support varies across runtimes/versions, and this works everywhere
 * a `ReadableStream` does.
 */
async function* webStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) return;
      if (value) yield value;
    }
  } finally {
    // Cancel before releasing the lock so an early-terminated or
    // downstream-failed consumer still tells the underlying source to
    // stop, instead of leaving it running with nothing left to read it.
    // An already-errored stream rejects cancel(); that rejection isn't
    // useful to the caller here, so it's swallowed.
    try {
      await reader.cancel();
    } catch {
      // Ignore: the stream may already be errored/closed.
    }

    reader.releaseLock();
  }
}

/** Default `requestStream`: native `fetch`, with the same error/`.status` contract non-streaming errors get. */
async function defaultRequestStream(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<AsyncIterable<Uint8Array | string>> {
  const res = await fetch(url, init);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(
      `Fetch adapter stream request failed (${res.status}): ${body.slice(0, 500)}`,
    ) as Error & { status?: number; headers?: ResponseLike['headers'] };

    err.status = res.status;
    err.headers = res.headers;

    throw err;
  }

  if (!res.body) {
    throw new Error('Fetch adapter stream request received a response with no body.');
  }

  return webStreamToAsyncIterable(res.body);
}

/** Builds the shared `{ method, headers, body? }` request-init for both `create` and `createStream`. */
async function buildRequestInit(
  config: FetchAdapterConfig,
  params: ChatRequest,
  requestBody: unknown,
): Promise<{ url: string; method: string; headers: Record<string, string>; body?: string }> {
  const url = typeof config.url === 'function' ? config.url(params) : config.url;
  const headers = typeof config.headers === 'function' ? await config.headers() : config.headers;
  const method = config.method ?? 'POST';

  // GET/HEAD requests can't carry a body, so skip both the body and
  // the Content-Type header for them rather than sending a body a
  // server may reject
  const supportsBody = !['GET', 'HEAD'].includes(method.toUpperCase());

  return {
    url,
    method,
    headers: supportsBody ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
    ...(supportsBody ? { body: JSON.stringify(requestBody) } : {}),
  };
}

/**
 * A fetch-based escape hatch for providers with no SDK, or where pulling one
 * in isnt worth it. You supply the URL, headers, and two small mapping
 * functions; this handles the HTTP call and slots the result into the same
 * `LLMClient` shape every other adapter produces, so retries, timeouts,
 * the circuit breaker, and JSON/schema handling all still work unmodified
 *
 * Non-2xx responses throw an error with `.status` set to the HTTP status
 * code, so VernLLMs `nonRetryableStatus` handling (e.g. failing fast on
 * 401/403) applies here too
 *
 * Tool calling works the same way as every other adapter: `mapRequest`
 * receives the full `ChatRequest`, including `tools`/`toolChoice`, so it can
 * translate them into whatever shape the provider's wire format expects
 * (typically an OpenAI-`function`-wrapped `tools` array plus a `tool_choice`
 * field). On the way back, `mapResponse` may return a `toolCalls` array
 * (id/name/JSON-encoded-arguments-string per call) alongside or instead of
 * `content`; VernLLM parses and (if `argumentsSchema` was set) validates
 * those arguments the same way it does for every other adapter. For
 * `stream: true`, tool-call deltas go through the existing
 * `mapStreamEvent` seam via `WireStreamChunk`'s `tool_call_delta` variant,
 * no separate config is needed for streaming vs non-streaming tool calls.
 *

 * `createStream` requires `mapStreamEvent` (there's no non-streaming
 * response to fall back on, unlike the other three optional streaming
 * seams). It opens the request via `requestStream` (defaults to native
 * `fetch`), splits the raw bytes into individual events via
 * `parseStreamFrames` (defaults to SSE framing, see `parseSseStream`),
 * and translates each event into `WireStreamChunk`(s) via
 * `mapStreamEvent`. Both seams are overridable per-config for providers
 * that don't fit the SSE-over-fetch default. If a custom `request`
 * transport is configured, `requestStream` must be configured too,
 * `requestStream` never silently falls back to `request` (see
 * `createStream`'s own comment for why), so a `stream: true` call with
 * `request` set but no `requestStream` throws a clear
 * `LLMError('validation')` instead of quietly using unrelated native
 * `fetch`.
 */
export function fromFetch(config: FetchAdapterConfig): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const { url, method, headers, body } = await buildRequestInit(
            config,
            params,
            config.mapRequest(params),
          );
          const request = config.request ?? fetch;

          const res = await request(url, { method, headers, body, signal: options.signal });

          if (!res.ok) {
            const responseBody = await res.text().catch(() => '');
            const err = new Error(
              `Fetch adapter request failed (${res.status}): ${responseBody.slice(0, 500)}`,
            ) as Error & { status?: number; headers?: ResponseLike['headers'] };
            err.status = res.status;
            // Attach headers so downstream retry logic (e.g. rate-limit
            // handling) can read things like `Retry-After`
            err.headers = res.headers;
            throw err;
          }

          const json = await res.json();
          const { content, usage, toolCalls } = config.mapResponse(json);

          const wireToolCalls: WireToolCall[] | undefined = toolCalls?.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));

          return {
            choices: [
              {
                message: {
                  content,
                  ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}),
                },
              },
            ],
            usage: usage
              ? {
                  prompt_tokens: usage.promptTokens,
                  completion_tokens: usage.completionTokens,
                  total_tokens: usage.totalTokens,
                }
              : undefined,
          };
        },

        async *createStream(params, options) {
          if (!config.mapStreamEvent) {
            throw new LLMError(
              'stream: true requires mapStreamEvent to be configured on fromFetch',
              'validation',
            );
          }

          // A custom `request` transport (proxying, special auth, test
          // mocking, etc.) is silently irrelevant to streaming unless the
          // caller *also* configures `requestStream`, `requestStream`
          // defaults to plain native `fetch`, not to `config.request`,
          // since `RequestLike`'s buffered `ResponseLike` has no way to
          // expose a byte stream generically. Falling back to native
          // `fetch` anyway would be a surprising, easy-to-miss divergence
          // (bypassing whatever `request` was there for, a proxy, custom
          // auth, or a test's mocked transport, and potentially hitting
          // the real network). Failing loudly here instead of guessing.
          if (config.request && !config.requestStream) {
            throw new LLMError(
              '`stream: true` requires `requestStream` to be configured on fromFetch when a ' +
                'custom `request` transport is set. `requestStream` does not fall back to ' +
                "`request` (it needs an async-iterable byte stream, which `RequestLike`'s " +
                'buffered `ResponseLike` has no way to provide), without it, `stream: true` ' +
                'would silently use plain native `fetch` instead of your configured transport. ' +
                'Add a `requestStream` that opens the same connection your `request` does, or ' +
                'omit `request` if native `fetch` is fine for both.',
              'validation',
            );
          }

          const { url, method, headers, body } = await buildRequestInit(
            config,
            params,
            config.mapRequest(params),
          );
          const requestStream = config.requestStream ?? defaultRequestStream;
          const parseFrames = config.parseStreamFrames ?? parseSseStream;

          const byteStream = await requestStream(url, {
            method,
            headers,
            body,
            signal: options.signal,
          });

          for await (const event of parseFrames(byteStream)) {
            // Only the default parseSseStream produces this sentinel (an
            // SSE comment line used as a keep-alive ping). Handled here,
            // before mapStreamEvent, since provider-specific mapping
            // shouldn't need to know about SSE framing internals.
            if (event === SSE_PING) {
              yield { type: 'ping' };
              continue;
            }

            const wireChunks = config.mapStreamEvent(event);

            if (!wireChunks) continue;

            if (Array.isArray(wireChunks)) {
              yield* wireChunks;
            } else {
              yield wireChunks;
            }
          }
        },
      },
    },
  };
}
