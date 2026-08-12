import { LLMError } from '../../types/errors.js';
import { extractRetryAfterMs } from './retry.utils.js';

/**
 * Looks inside an unknown error value and pulls out an http status code
 * if one is present. Checks the status field first then the status code
 * field since different client libraries use different names for this,
 * falling back to AWS SDK v3's `$metadata.httpStatusCode` (e.g. Bedrock's
 * `ThrottlingException`), which doesn't set either of the other two.
 * Returns undefined when the error is not an object or carries no status
 */
export function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const error = err as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  if (typeof error.status === 'number') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;
  if (typeof error.$metadata?.httpStatusCode === 'number') return error.$metadata.httpStatusCode;

  return undefined;
}

function formatSafely(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unprintable error]';
    }
  }
}

/**
 * Looks inside an unknown thrown value and pulls out a human-readable
 * description of it. Checks the `error` field first (the provider's raw
 * rejection body, JSON-stringified if possible) then falls back to the
 * message` field. Always returns a safe string, even when the thrown value
 * has hostile properties or cannot be serialized normally.
 */
export function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    try {
      const error = err as { message?: unknown; error?: unknown };

      if (error.error !== undefined) {
        return formatSafely(error.error);
      }

      if (typeof error.message === 'string') {
        return error.message;
      }
    } catch {
      // Fall through to safe string.
    }
  }

  return formatSafely(err);
}

/** Converts any thrown value into a well-typed LLMError. */
export function normalizeError(error: unknown, signal?: AbortSignal): LLMError {
  if (signal?.aborted) {
    return new LLMError('LLM request aborted', 'aborted');
  }

  if (error instanceof LLMError) {
    // A caller or adapter can throw an already-built LLMError directly
    // (bypassing the generic-SDK-error path below), so a 429 reaching us
    // this way still needs the same `code` a generic 429 gets, without
    // overwriting a `code` that error already carries.
    if (error.status === 429 && error.code === undefined) {
      error.code = 'provider_rate_limited';
    }

    return error;
  }

  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterMs(error);

  if (status !== undefined) {
    return new LLMError(
      'LLM request failed',
      'api',
      status,
      undefined,
      error,
      retryAfterMs,
      status === 429 ? 'provider_rate_limited' : undefined,
    );
  }

  return new LLMError('LLM request failed', 'unknown', undefined, undefined, error, retryAfterMs);
}
