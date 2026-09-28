import {
  parseOpenAIRateLimitHeaders,
  type ProviderRateLimitHint,
} from '../../internal/utils/rate-limit/rateLimitHint.utils.js';
import { httpResponseError, unsupportedCapability } from '../internal/errors.js';

import type { ChatRequest, FetchAdapterConfig, ResponseLike } from './types.js';

/**
 * Makes a `ReadableStream` iterable through `getReader()`, since native
 * `Symbol.asyncIterator` support varies across runtimes.
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
    // Cancel before releasing the lock so a consumer that stops early still
    // tells the source to stop. An already-errored stream rejects cancel(),
    // which is of no use to the caller here.
    try {
      await reader.cancel();
    } catch {
      // Ignore: the stream may already be errored/closed.
    }

    reader.releaseLock();
  }
}

/**
 * The default streaming transport, native `fetch`, which also returns the
 * response headers for AIMD's proactive hint. A custom `requestStream` only
 * returns bytes, so it gets no proactive hint.
 */
async function defaultRequestStreamWithHeaders(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<{ headers: ResponseLike['headers']; body: AsyncIterable<Uint8Array | string> }> {
  const res = await fetch(url, init);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw httpResponseError('Fetch adapter stream request failed', res, body);
  }

  if (!res.body) {
    throw new Error('Fetch adapter stream request received a response with no body.');
  }

  return { headers: res.headers, body: webStreamToAsyncIterable(res.body) };
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

  // GET and HEAD can't carry a body, so neither it nor Content-Type is sent.
  const supportsBody = !['GET', 'HEAD'].includes(method.toUpperCase());

  return {
    url,
    method,
    headers: supportsBody ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
    ...(supportsBody ? { body: JSON.stringify(requestBody) } : {}),
  };
}

/** Sends the request through `config.request`, native `fetch` by default, and throws on a non-2xx. */
export async function requestOnce(
  config: FetchAdapterConfig,
  params: ChatRequest,
  signal: AbortSignal,
): Promise<ResponseLike> {
  const { url, method, headers, body } = await buildRequestInit(
    config,
    params,
    config.mapRequest(params),
  );
  const request = config.request ?? fetch;

  const res = await request(url, { method, headers, body, signal });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throw httpResponseError('Fetch adapter request failed', res, responseBody);
  }

  return res;
}

/**
 * Opens the streaming request, through `config.requestStream` or native
 * `fetch`. Only native `fetch` reports headers.
 */
export async function openStream(
  config: FetchAdapterConfig,
  params: ChatRequest,
  signal: AbortSignal,
): Promise<{ headers?: ResponseLike['headers']; body: AsyncIterable<Uint8Array | string> }> {
  // Falling back to native fetch would quietly bypass whatever the custom
  // `request` is for (a proxy, auth, a test's mock), so this fails instead
  // of guessing.
  if (config.request && !config.requestStream) {
    throw unsupportedCapability(
      '`stream: true` requires `requestStream` to be configured on fromFetch when a ' +
        'custom `request` transport is set. `requestStream` does not fall back to ' +
        "`request` (it needs an async-iterable byte stream, which `RequestLike`'s " +
        'buffered `ResponseLike` has no way to provide), without it, `stream: true` ' +
        'would silently use plain native `fetch` instead of your configured transport. ' +
        'Add a `requestStream` that opens the same connection your `request` does, or ' +
        'omit `request` if native `fetch` is fine for both.',
      'requestStream',
    );
  }

  const { url, method, headers, body } = await buildRequestInit(
    config,
    params,
    config.mapRequest(params),
  );
  const init = { method, headers, body, signal };

  if (config.requestStream) return { body: await config.requestStream(url, init) };
  return defaultRequestStreamWithHeaders(url, init);
}

/**
 * AIMD's proactive hint from response headers, `undefined` without them. A
 * test double may omit `headers` despite `ResponseLike` declaring it.
 */
export function readRateLimitHint(
  config: FetchAdapterConfig,
  headers: ResponseLike['headers'] | undefined,
): ProviderRateLimitHint | undefined {
  if (!headers || typeof headers.get !== 'function') return undefined;
  return (config.parseRateLimitHint ?? parseOpenAIRateLimitHeaders)(headers);
}
