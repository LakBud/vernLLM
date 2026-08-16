import { LLMError, type LLMErrorCode, type RetryAttempt } from '../../types/errors.js';
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

/**
 * POSIX/libuv error codes libuv (and so Node's `fetch`/undici) attaches to
 * genuine transport-level failures: connection refused, DNS lookup
 * failure, connection reset mid-request, a connect that never completed,
 * DNS server unreachable, broken pipe, or host/network unreachable.
 * Deliberately narrow: only codes that can only mean "the connection
 * itself failed," not anything that could also indicate an application
 * error.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** `fetch`'s own wording for a transport-level failure, across runtimes/browsers. */
const NETWORK_ERROR_MESSAGES = new Set([
  'fetch failed', // Node/undici
  'failed to fetch', // Chromium
  'load failed', // Safari
  'networkerror when attempting to fetch resource.', // Firefox
]);

/**
 * Whether `error` is, with reasonable confidence, a transport-level
 * failure (never reached the provider, as opposed to the provider itself
 * responding with an error) rather than some other unexpected exception.
 * Checked via explicit, well-known signals only, so a genuinely unknown
 * error never gets misclassified as a connection failure just because it
 * also lacked an HTTP status.
 */
function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as { code?: unknown; message?: unknown; cause?: unknown };

  if (typeof err.code === 'string' && NETWORK_ERROR_CODES.has(err.code)) return true;

  if (typeof err.message === 'string' && NETWORK_ERROR_MESSAGES.has(err.message.toLowerCase())) {
    return true;
  }

  // undici/Node's `fetch` wraps the real libuv error one level down, as
  // TypeError('fetch failed', { cause: <the real error, with .code> }).
  // The message check above already catches that wrapper by itself if
  // the cause is missing or unrecognized, this catches it by the cause's
  // code when the wrapper's own message wasn't matched (e.g. a runtime
  // that phrases the wrapper differently but still sets `cause.code`).
  if (err.cause && typeof err.cause === 'object') {
    const cause = err.cause as { code?: unknown };
    if (typeof cause.code === 'string' && NETWORK_ERROR_CODES.has(cause.code)) return true;
  }

  return false;
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

/**
 * Maps an HTTP status to its corresponding `LLMErrorCode`, derived purely
 * from the status itself so it applies the same way regardless of which
 * adapter or client raised the error. Used both when building a fresh
 * `LLMError` and when filling in a `code` on an already-normalized one
 * that doesn't have one yet, so the two paths can't drift apart.
 */
function codeForStatus(status: number): LLMErrorCode | undefined {
  switch (status) {
    case 429:
      return 'provider_rate_limited';
    case 401:
      return 'authentication';
    case 403:
      return 'authorization';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    default:
      return status >= 500 ? 'server_error' : undefined;
  }
}

/**
 * Converts any thrown value into a well-typed LLMError. `attempts`, when
 * given, is the accumulated record of every attempt made before `error`
 * was thrown; it's passed straight into the constructed error's options
 * rather than assigned onto the error afterward, so `attempts` is always
 * settled once, through the constructor, like every other field on
 * `LLMError`.
 */
export function normalizeError(
  error: unknown,
  signal?: AbortSignal,
  attempts?: RetryAttempt[],
): LLMError {
  if (signal?.aborted) {
    return new LLMError('LLM request aborted', 'aborted', { attempts });
  }

  if (error instanceof LLMError) {
    // A caller or adapter can throw an already-built LLMError directly
    // (bypassing the generic-SDK-error path below), so a status reaching
    // us this way still needs the same `code` a generic error with that
    // status gets, without overwriting a `code` that error already carries.
    if (error.code === undefined && error.status !== undefined) {
      error.code = codeForStatus(error.status);
    }

    // Same rule for `attempts`: fill it in if this already-built error
    // doesn't carry one of its own, without overwriting one it does.
    if (error.attempts === undefined && attempts !== undefined) {
      error.attempts = attempts;
    }

    return error;
  }

  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterMs(error);

  if (status !== undefined) {
    return new LLMError('LLM request failed', 'api', {
      status,
      cause: error,
      retryAfterMs,
      code: codeForStatus(status),
      attempts,
    });
  }

  // No extractable HTTP status: distinguish a genuine transport-level
  // failure (DNS, connection refused, connection reset) from any other
  // unexpected exception via explicit signals only, rather than assuming
  // every status-less error reaching here is a connection failure.
  if (isNetworkError(error)) {
    return new LLMError('LLM request failed', 'network', {
      cause: error,
      retryAfterMs,
      code: 'connection_failed',
      attempts,
    });
  }

  return new LLMError('LLM request failed', 'unknown', { cause: error, retryAfterMs, attempts });
}
