import { LLMError } from '../types/errors.js';

import type { UsageHooks } from '../types/usage.js';

export function defaultParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * Looks inside an unknown error value and pulls out an http status code
 * if one is present. Checks the status field first then the status code
 * field since different client libraries use different names for this.
 * Returns undefined when the error is not an object or carries no status
 */
export function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const error = err as {
    status?: unknown;
    statusCode?: unknown;
  };

  if (typeof error.status === 'number') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;

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

/**
 * Runs an async function and cancels it if it takes longer than the given
 * timeout. Creates an internal abort controller that fires after the
 * timeout elapses, and combines it with any external signal the caller
 * passed in so either one can cancel the underlying call. If the internal
 * timeout triggers and the underlying operation aborts, the error is
 * converted into an LLMError with type "timeout". External cancellations
 * continue to propagate as aborted errors. The internal timer is always
 * cleared afterward, whether the function succeeds, fails, or is aborted,
 * so nothing is left running in the background.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;

  try {
    return await fn(signal);
  } catch (err) {
    if (
      controller.signal.aborted &&
      !externalSignal?.aborted &&
      err instanceof DOMException &&
      err.name === 'AbortError'
    ) {
      throw new LLMError('Request timed out', 'timeout');
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default cap (ms) for both exponential backoff and honored Retry-After
 * values, so a misbehaving/adversarial Retry-After can't stall a caller
 * indefinitely
 */
export const DEFAULT_MAX_DELAY_MS = 10_000;

/**
 * Looks inside an unknown error value for a Retry-After header and
 * converts it to milliseconds. Checks `.headers` first (fetch-style,
 * Headers-like with `.get()`), then `.response.headers` (axios-style,
 * plain object) since different client libraries surface headers
 * differently. Supports both the delta-seconds form ("30") and the
 * HTTP-date form ("Wed, 21 Oct 2015 07:28:00 GMT"). The result is capped
 * at maxDelayMs. Returns undefined when no usable Retry-After is present
 */
export function extractRetryAfterMs(
  err: unknown,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const error = err as { headers?: unknown; response?: { headers?: unknown } };
  const headers = error.headers ?? error.response?.headers;

  if (!headers || typeof headers !== 'object') return undefined;

  const getter = headers as { get?: (name: string) => string | null };

  const raw =
    typeof getter.get === 'function'
      ? getter.get('Retry-After')
      : Object.entries(headers as Record<string, string>)
          .find(([name]) => name.toLowerCase() === 'retry-after')
          ?.at(1);

  if (typeof raw !== 'string' || raw.trim() === '') return undefined;

  const trimmed = raw.trim();

  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Math.min(Number(trimmed) * 1000, maxDelayMs));
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), maxDelayMs));
  }

  return undefined;
}

/** Converts any thrown value into a well-typed LLMError. */
export function normalizeError(error: unknown, signal?: AbortSignal): LLMError {
  if (signal?.aborted) {
    return new LLMError('LLM request aborted', 'aborted');
  }

  if (error instanceof LLMError) return error;

  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterMs(error);

  if (status !== undefined) {
    return new LLMError('LLM request failed', 'api', status, undefined, error, retryAfterMs);
  }

  return new LLMError('LLM request failed', 'unknown', undefined, undefined, error, retryAfterMs);
}

/**
 * Exponential backoff with jitter, capped at maxDelayMs.
 * Jitter avoids thundering-herd retries when many callers back off in lockstep,
 * the cap prevents unbounded delays when maxRetries is high
 */
export function getBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return exp / 2 + Math.random() * (exp / 2);
}

/**
 * Pauses execution for the given delay before a retry attempt. If an
 * abort signal is provided and it fires while waiting, the pending
 * timer is cancelled immediately and the wait rejects right away with
 * an aborted error instead of continuing to sit idle until the delay
 * would have finished on its own
 */
export async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LLMError('Operation aborted', 'aborted'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `getResult` after reserving usage, if a `reserveUsage` hook was
 * provided. `refundUsage` fires only if a reservation was actually made.
 * `onRefundError` is called (instead of throwing) whenever a refund attempt
 * itself fails, so a broken refund hook never masks the original error.
 */
export async function withReservedUsage<T>(
  params: UsageHooks,
  coalesced: boolean,
  getResult: () => Promise<T>,
  signal: AbortSignal | undefined,
  onRefundError: (logMessage: string, error: unknown) => void,
): Promise<T> {
  if (signal?.aborted) {
    throw new LLMError('LLM request aborted', 'aborted');
  }

  let reserved = false;

  try {
    if (params.reserveUsage) {
      await params.reserveUsage({ coalesced, signal });
      reserved = true;
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    throw new LLMError(
      error instanceof Error ? error.message : 'Usage reservation failed',
      'quota_exceeded',
      undefined,
      undefined,
      error,
    );
  }

  const refund = async (logMessage: string) => {
    try {
      await params.refundUsage?.({ coalesced, signal });
    } catch (refundError) {
      onRefundError(logMessage, refundError);
    }
  };

  if (signal?.aborted) {
    if (reserved) await refund('[VernLLM] refundUsage failed after abort');
    throw new LLMError('LLM request aborted', 'aborted');
  }

  let result: T;

  try {
    result = await getResult();
  } catch (error) {
    if (reserved) await refund('[VernLLM] refundUsage failed');
    throw error;
  }

  if (signal?.aborted) {
    if (reserved) await refund('[VernLLM] refundUsage failed after abort');
    throw new LLMError('LLM request aborted', 'aborted');
  }

  return result;
}
