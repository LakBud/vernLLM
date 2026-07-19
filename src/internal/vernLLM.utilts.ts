import { LLMError } from "../types.js";


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
 * passed in so either one can cancel the underlying call. The internal
 * timer is always cleared afterward, whether the function succeeds,
 * fails, or is aborted, so nothing is left running in the background
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
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exponential backoff with jitter, capped at maxDelayMs.
 * Jitter avoids thundering-herd retries when many callers back off in lockstep,
 * the cap prevents unbounded delays when maxRetries is high
 */
export function getBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs = 10_000,
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
export async function waitForRetry(
  delay: number,
  signal?: AbortSignal,
): Promise<void> {
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