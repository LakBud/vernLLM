import type { LLMClient } from '../types/index.js';

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
   * Maps the providers raw JSON response into `{ content, usage? }`
   * `content` is the assistants text (JSON string when JSON mode was requested)
   */
  mapResponse: (json: unknown) => {
    content: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
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
 */
export function fromFetch(config: FetchAdapterConfig): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const url = typeof config.url === 'function' ? config.url(params) : config.url;
          const headers =
            typeof config.headers === 'function' ? await config.headers() : config.headers;
          const method = config.method ?? 'POST';
          const request = config.request ?? fetch;

          // GET/HEAD requests can't carry a body, so skip both the body and
          // the Content-Type header for them rather than sending a body a
          // server may reject
          const supportsBody = !['GET', 'HEAD'].includes(method.toUpperCase());

          const res = await request(url, {
            method,
            headers: supportsBody
              ? { 'Content-Type': 'application/json', ...headers }
              : { ...headers },
            ...(supportsBody ? { body: JSON.stringify(config.mapRequest(params)) } : {}),
            signal: options.signal,
          });

          if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error(
              `Fetch adapter request failed (${res.status}): ${body.slice(0, 500)}`,
            ) as Error & { status?: number; headers?: ResponseLike['headers'] };
            err.status = res.status;
            // Attach headers so downstream retry logic (e.g. rate-limit
            // handling) can read things like `Retry-After`
            err.headers = res.headers;
            throw err;
          }

          const json = await res.json();
          const { content, usage } = config.mapResponse(json);

          return {
            choices: [{ message: { content } }],
            usage: usage
              ? {
                  prompt_tokens: usage.promptTokens,
                  completion_tokens: usage.completionTokens,
                  total_tokens: usage.totalTokens,
                }
              : undefined,
          };
        },
      },
    },
  };
}
