import { LLMError } from '../types/errors.js';

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
 * Default cap (ms) for both exponential backoff and honored Retry-After values
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

  const raw =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get: (name: string) => string | null }).get('Retry-After')
      : ((headers as Record<string, unknown>)['retry-after'] as string | undefined);

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
