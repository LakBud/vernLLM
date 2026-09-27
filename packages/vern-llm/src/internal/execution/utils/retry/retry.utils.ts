import { LLMError, type LLMRequestSnapshot, type RetryAttempt } from '../../../../types/errors.js';
import { DEFAULT_MAX_DELAY_MS, extractRetryAfterMs } from './retryAfter.utils.js';
import { clampTimeoutMs } from './timeout.utils.js';

import type { Logger } from '../../../../logger.js';
import type {
  AttemptContext,
  MiddlewareStateBag,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../../types/index.js';

export {
  DEFAULT_MAX_DELAY_MS,
  extractRetryAfterMs,
  validateMaxRetryAfterMs,
} from './retryAfter.utils.js';
export {
  clampTimeoutMs,
  resolveActiveTimeoutMs,
  withChunkIdleTimeout,
  withTimeout,
} from './timeout.utils.js';

/**
 * Full jitter: uniform over `[0, exp]`. Shared by retry backoff and the breaker's cooldown backoff.
 */
export function fullJitter(exp: number): number {
  return Math.random() * exp;
}

/**
 * Exponential backoff with full jitter, capped at `maxDelayMs`. Without a Retry-After, a 429 backs
 * off hardest and a 5xx more than the default curve; `rateLimited` wins when both are set.
 */
export function getBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  rateLimited = false,
  serverError = false,
): number {
  const multiplier = rateLimited ? 2 : serverError ? 1.5 : 1;
  const exp = Math.min(baseDelayMs * multiplier * 2 ** attempt, maxDelayMs);
  return fullJitter(exp);
}

/** Waits `delay` ms before a retry. Rejects as aborted at once when `signal` fires. */
export async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new LLMError('Operation aborted', 'aborted');
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LLMError('Operation aborted', 'aborted'));
    };

    // A Retry-After cap of Infinity can hand over a delay setTimeout would
    // wrap to ~1ms, the opposite of the wait the provider asked for.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, clampTimeoutMs(delay));

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Whether a failed attempt is worth retrying, per `LLMError.retryable`
 * and `nonRetryableStatus`. Takes `extractStatus` as a param instead of
 * importing it, since `errors.utils.ts` already imports from this file.
 */
export function shouldRetry(
  error: unknown,
  nonRetryableStatus: number[],
  extractStatus: (err: unknown) => number | undefined,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return false;

  if (error instanceof LLMError && !error.retryable) return false;

  const status = extractStatus(error);

  return !(status !== undefined && nonRetryableStatus.includes(status));
}

/**
 * Everything `recoverDelay` needs. `extractStatus`, `normalizeError`, and
 * `emitEvent` are injected instead of imported, since `errors.utils.ts`
 * already imports from this file.
 */
export interface RecoverDelayParams {
  requestId: string;
  model: string;
  attempt: number;
  error: unknown;
  state: MiddlewareStateBag;
  signal: AbortSignal | undefined;
  providerName: string;
  maxRetries: number;
  baseDelayMs: number;
  /** See `VernLLMOptions.maxRetryAfterMs`. Omitted means the 10s default. */
  maxRetryAfterMs?: number;
  middleware: VernLLMMiddleware[];
  middlewareTimeoutMs: number;
  logger: Logger;
  reportEvent: (event: VernLLMEvent) => void;
  buildEventContext: (
    requestId: string,
    model: string,
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ) => AttemptContext;
  extractStatus: (err: unknown) => number | undefined;
  normalizeError: (err: unknown, signal?: AbortSignal) => LLMError;
  emitEvent: (
    event: VernLLMEvent,
    ctx: AttemptContext,
    reportEvent: (event: VernLLMEvent) => void,
    middleware: VernLLMMiddleware[],
    middlewareTimeoutMs: number,
    logger: Logger,
  ) => void;
}

/**
 * Waits before a retry, honoring the failed attempt's Retry-After when present, otherwise the
 * backoff curve for its status. Both are capped at the same max delay.
 */
export async function recoverDelay(params: RecoverDelayParams): Promise<void> {
  const {
    requestId,
    model,
    attempt,
    error,
    state,
    signal,
    providerName,
    maxRetries,
    baseDelayMs,
    maxRetryAfterMs,
    middleware,
    middlewareTimeoutMs,
    logger,
    reportEvent,
    buildEventContext,
    extractStatus,
    normalizeError,
    emitEvent,
  } = params;

  const retryAfterMs = extractRetryAfterMs(error, maxRetryAfterMs);
  const status = extractStatus(error);
  const delay =
    retryAfterMs ??
    getBackoffDelay(
      baseDelayMs,
      attempt,
      undefined,
      status === 429,
      status !== undefined && status >= 500 && status <= 599,
    );
  const retryAfterHonored = retryAfterMs !== undefined;

  logger.warn(
    `[VernLLM:${requestId}] recovery attempt ${attempt}/${maxRetries}, waiting ${Math.ceil(delay)}ms` +
      (retryAfterHonored ? ' (honoring Retry-After)' : ''),
  );

  emitEvent(
    {
      kind: 'retry',
      requestId,
      provider: providerName,
      model,
      attempt,
      maxRetries,
      delayMs: delay,
      retryAfterHonored,
      error: normalizeError(error, signal),
    },
    buildEventContext(requestId, model, attempt, signal, state),
    reportEvent,
    middleware,
    middlewareTimeoutMs,
    logger,
  );

  await waitForRetry(delay, signal);
}

/**
 * Runs `fn` with retries. Each retried failure is recorded in `attempts` as a snapshot; the final
 * failure is the thrown error itself.
 */
export interface RetryWithBackoffParams<T> {
  fn: (
    attempt: number,
    onRequest: (snapshot: LLMRequestSnapshot | undefined) => void,
  ) => Promise<T>;
  maxRetries: number;
  signal?: AbortSignal;
  onAttempt?: () => void;
  attempts?: RetryAttempt[];
  shouldRetryAttempt: (error: unknown, signal?: AbortSignal) => boolean;
  recoverDelayForAttempt: (attempt: number, error: unknown) => Promise<void>;
  /** Injected for the same reason as on `RecoverDelayParams`. */
  normalizeError: (err: unknown, signal?: AbortSignal) => LLMError;
}

/**
 * A usable retry count. NaN, negative or non-number values would skip the loop and make no call, so
 * they mean one attempt. Fractions round down; `Infinity` stays.
 */
export function normalizeMaxRetries(maxRetries: number): number {
  if (typeof maxRetries !== 'number' || Number.isNaN(maxRetries) || maxRetries < 0) return 0;
  return Math.floor(maxRetries);
}

export async function retryWithBackoff<T>(params: RetryWithBackoffParams<T>): Promise<T> {
  const {
    fn,
    signal,
    onAttempt,
    attempts,
    shouldRetryAttempt,
    recoverDelayForAttempt,
    normalizeError,
  } = params;
  const maxRetries = normalizeMaxRetries(params.maxRetries);

  let lastError: unknown;
  let lastRequestForAttempt: LLMRequestSnapshot | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Reset before this iteration's own onRequest can run. If this
    // attempt fails before onRequest is ever called (e.g. thrown by
    // recoverDelayForAttempt or onAttempt, before fn/onRequest runs), the
    // previous attempt's request must not be misattributed to this
    // attempt's index below.
    lastRequestForAttempt = undefined;

    try {
      if (attempt > 0) {
        await recoverDelayForAttempt(attempt, lastError);
      }

      onAttempt?.();
      return await fn(attempt, (req) => {
        lastRequestForAttempt = req;
      });
    } catch (error) {
      lastError = error;

      const willRetry = attempt < maxRetries && shouldRetryAttempt(error, signal);
      if (!willRetry) break;

      attempts?.push({
        index: attempt,
        error: normalizeError(error, signal).toSnapshot(),
        request: lastRequestForAttempt,
      });
    }
  }

  throw lastError;
}
