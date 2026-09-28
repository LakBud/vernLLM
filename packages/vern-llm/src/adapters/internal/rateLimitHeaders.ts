import type {
  HeaderReader,
  ProviderRateLimitHint,
} from '../../internal/utils/rate-limit/rateLimitHint.utils.js';
import type { WireStreamChunk } from '../../types/index.js';

/**
 * Calls `.withResponse()` on an SDK request promise (the `openai` and
 * `@anthropic-ai/sdk` `APIPromise`), for the response headers AIMD reads.
 * Only for clients known to support it, since the structural client types
 * don't declare it.
 */
export async function withRawResponse<T>(
  request: unknown,
): Promise<{ data: T; headers: HeaderReader }> {
  const { data, response } = await (
    request as { withResponse(): Promise<{ data: T; response: { headers: HeaderReader } }> }
  ).withResponse();

  return { data, headers: response.headers };
}

/**
 * The `rate_limit_hint` chunk a stream yields before its content, or
 * `undefined` when the headers carried no limit or remaining count, so an
 * empty hint never reaches the limiter.
 */
export function rateLimitHintChunk(hint: ProviderRateLimitHint): WireStreamChunk | undefined {
  return hint.remainingRequests !== undefined || hint.limitRequests !== undefined
    ? { type: 'rate_limit_hint', hint }
    : undefined;
}

/**
 * Sends a request, reading its response headers too when the client supports
 * `.withResponse()`. `headers` is left out otherwise.
 */
export async function sendWithHeaders<T>(
  request: () => unknown,
  withHeaders: boolean,
): Promise<{ data: T; headers?: HeaderReader }> {
  if (!withHeaders) return { data: (await request()) as T };
  return withRawResponse<T>(request());
}
