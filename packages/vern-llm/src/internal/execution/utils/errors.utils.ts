import { LLMError, type LLMErrorCode, type RetryAttempt } from '../../../types/errors.js';
import { extractRetryAfterMs } from './retry/retry.utils.js';

/**
 * The HTTP status on an unknown error: `status`, then `statusCode`, then the AWS SDK's
 * `$metadata.httpStatusCode`. `undefined` when none is present.
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

/** Error codes that can only mean the connection itself failed, never an application error. */
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
 * Whether `error` is a transport failure that never reached the provider. Only well known signals
 * count, so an unknown error isn't misread as a connection failure.
 */
function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as { code?: unknown; message?: unknown; cause?: unknown };

  if (typeof err.code === 'string' && NETWORK_ERROR_CODES.has(err.code)) return true;

  if (typeof err.message === 'string' && NETWORK_ERROR_MESSAGES.has(err.message.toLowerCase())) {
    return true;
  }

  // Node's `fetch` wraps the real error in `TypeError('fetch failed', { cause })`. This catches it
  // by the cause's code when the wrapper message differs.
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
 * A readable description of a thrown value: its `error` field (the provider body), else `message`.
 * Always a safe string.
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
 * The `LLMErrorCode` for an HTTP status, shared by new and already normalized errors so they can't
 * drift.
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
 * Some providers answer a non-2xx with no body, which SDKs render as `"400 status code (no body)"`.
 * Detail is read from the `error` and `message` fields directly, since `describeError` falls back
 * to echoing the whole value.
 */
const NO_BODY_MESSAGE_PATTERN = /\(no body\)/i;

function isEmptyObject(value: object): boolean {
  return Object.keys(value).length === 0;
}

function hasNoDiagnosticDetail(error: unknown): boolean {
  // Defensive: this function's only call site (below, in normalizeError)
  // reaches it via a status extracted by extractStatus, which itself
  // only returns a status for an object input, so `error` is always an
  // object here in practice. Kept for callers this function doesn't
  // control yet, and as a safe fallback if that invariant ever changes.
  /* v8 ignore next */
  if (error && typeof error === 'object') {
    const { error: errorField, message } = error as { error?: unknown; message?: unknown };

    // A non-empty `error` is the provider's body and counts as detail. `null`, `''` and `{}` are
    // placeholders and fall through.
    if (errorField !== undefined && errorField !== null) {
      const isEmptyString = typeof errorField === 'string' && errorField.trim().length === 0;
      const isEmptyStruct = typeof errorField === 'object' && isEmptyObject(errorField);

      if (!isEmptyString && !isEmptyStruct) {
        return false;
      }
    }

    if (typeof message === 'string') {
      const trimmed = message.trim();
      return trimmed.length === 0 || NO_BODY_MESSAGE_PATTERN.test(trimmed);
    }

    // Neither a meaningful `.error` nor a `.message` string: describeError
    // has nothing of the provider's own to report and falls back to
    // stringifying the whole object instead.
    return true;
  }

  // A non-object thrown value (string, number, etc.) has no `.error`/
  // `.message` fields to check at all. Also unreachable in practice for
  // the same reason as the guard above (extractStatus already filters
  // non-object errors before this function is ever called).
  /* v8 ignore next */
  return true;
}

/**
 * Converts any thrown value into an `LLMError`. `attempts` goes through the constructor like every
 * other field.
 */
export function normalizeError(
  error: unknown,
  signal?: AbortSignal,
  attempts?: RetryAttempt[],
  maxRetryAfterMs?: number,
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

    // Same cap a header parsed below gets, so a thrown LLMError can't
    // outwait the target's maxRetryAfterMs. `!== undefined` keeps a 0 cap.
    if (maxRetryAfterMs !== undefined && error.retryAfterMs !== undefined) {
      error.retryAfterMs = Math.min(error.retryAfterMs, maxRetryAfterMs);
    }

    return error;
  }

  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterMs(error, maxRetryAfterMs);

  if (status !== undefined) {
    const description = describeError(error);

    // The provider's description goes into the message itself, so it is there without debug
    // logging.
    const code = codeForStatus(status);

    // The "probably an unsupported field/value" guidance is only accurate
    // for statuses that don't already have a more specific, known meaning
    // (auth, rate limiting, not-found, payload-too-large, server errors);
    // for those, a no-body response is just a no-body response and the
    // field-validation explanation would be actively misleading.
    const isRequestValidationStatus = code === undefined;

    const message = hasNoDiagnosticDetail(error)
      ? isRequestValidationStatus
        ? `LLM request failed with status ${status} and no error detail from the provider. This usually means a field or value in the request isn't supported by the specific model (for example, a reasoning/thinking parameter the model doesn't accept), rather than a transport or auth problem.`
        : `LLM request failed with status ${status} and no error detail from the provider.`
      : `LLM request failed: ${description}`;

    return new LLMError(message, 'api', {
      status,
      cause: error,
      retryAfterMs,
      code,
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
