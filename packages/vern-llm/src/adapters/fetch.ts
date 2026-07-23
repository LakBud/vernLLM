import type { LLMClient } from '../types/index.js';

/** The chat-completion-shaped request VernLLM builds internally */
type ChatRequest = Parameters<LLMClient['chat']['completions']['create']>[0];

export interface FetchAdapterConfig {
  /** Endpoint URL, or a function of the request in case it depends on model/params */
  url: string | ((params: ChatRequest) => string);
  /** Static headers, or a function (sync or async) for things like refreshed auth tokens */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /** HTTP method. Default 'POST' */
  method?: string;
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

          const res = await fetch(url, {
            method: config.method ?? 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(config.mapRequest(params)),
            signal: options.signal,
          });

          if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error(
              `Fetch adapter request failed (${res.status}): ${body.slice(0, 500)}`,
            ) as Error & { status?: number };
            err.status = res.status;
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
