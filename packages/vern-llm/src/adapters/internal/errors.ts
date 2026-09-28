import { errorWithResponseBody } from '../../internal/utils/errors/responseBody.utils.js';
import { LLMError } from '../../types/index.js';

import type { HeaderReader } from '../../internal/utils/rate-limit/rateLimitHint.utils.js';

/**
 * `LLMError('invalid_params')`, code `unsupported_capability`, for a request
 * the adapter or model can't serve. Thrown before dispatch, so it is never
 * retried, never counts toward the breaker, and fallback may still try
 * another target.
 */
export function unsupportedCapability(message: string, capability: string): LLMError {
  return new LLMError(message, 'invalid_params', {
    code: 'unsupported_capability',
    issues: { capability },
  });
}

/** An error for a non-2xx HTTP response, shaped the way core classifies SDK errors. */
export type HttpResponseError = Error & { status: number; headers?: HeaderReader };

/**
 * The error for a non-2xx HTTP response. The body stays redactable, `status`
 * drives retry and breaker decisions, and `headers` lets core read
 * Retry-After and rate limit headers off it.
 */
export function httpResponseError(
  prefix: string,
  response: { status: number; headers?: HeaderReader },
  body: string,
): HttpResponseError {
  const error = errorWithResponseBody(`${prefix} (${response.status})`, body) as HttpResponseError;

  error.status = response.status;
  error.headers = response.headers;

  return error;
}
