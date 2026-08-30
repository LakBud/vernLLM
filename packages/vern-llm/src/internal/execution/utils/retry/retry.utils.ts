import { LLMError, type LLMRequestSnapshot, type RetryAttempt } from '../../../../types/errors.js';

import type { Logger } from '../../../../logger.js';
import type {
  AttemptContext,
  MiddlewareStateBag,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../../types/index.js';

/**
 * Default cap (ms) for both exponential backoff and honored Retry-After
 * values, so a misbehaving/adversarial Retry-After can't stall a caller
 * indefinitely
 */
export const DEFAULT_MAX_DELAY_MS = 10_000;

/**
 * `setTimeout` silently clamps any delay above this (~24.8 days) or
 * `Infinity` down to ~1ms instead of erroring, so a caller passing
 * `Infinity` as "no timeout" gets the opposite of what they asked for.
 * Both timeout helpers below guard against this explicitly.
 */
const MAX_SETTIMEOUT_MS = 2_147_483_647;

/**
 * Resolves a timeout value to the number `setTimeout` should actually use,
 * or `undefined` when the timeout should be treated as disabled (0,
 * negative, or `Infinity`). Returning the resolved value directly, rather
 * than a boolean, lets callers narrow `number | undefined` to `number`
 * without an `as number` cast.
 */
function resolveActiveTimeoutMs(ms: number | undefined): number | undefined {
  return !ms || ms <= 0 || ms === Infinity ? undefined : ms;
}

/** Caps a timeout at the largest delay `setTimeout` actually honors. */
function clampTimeoutMs(ms: number): number {
  return Math.min(ms, MAX_SETTIMEOUT_MS);
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
 *
 * `timeoutMs` of `Infinity` (or any value beyond what `setTimeout` can
 * represent) disables the timeout rather than firing almost immediately.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();

  const activeTimeoutMs = resolveActiveTimeoutMs(timeoutMs);

  const timer =
    activeTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort();
        }, clampTimeoutMs(activeTimeoutMs));

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
      throw new LLMError('Request timed out', 'timeout', { code: 'request_timeout' });
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Races one `iterator.next()` call against a per-call idle timer, to
 * bound the gap *between* chunks (unlike `withTimeout`, which only bounds
 * opening the stream and its first chunk). Without this, a connection
 * that streams one chunk then hangs would never fail.
 *
 * `timeoutMs` of 0/undefined/`Infinity` disables the check. Otherwise
 * rejects with `LLMError('timeout')` if `next()` doesn't settle in time.
 * The clock resets on every call, so the window is measured from the most
 * recent chunk, not from stream start.
 *
 * `onIdle`, if given, is called the moment the timer fires (before the
 * rejection), so callers can abort the underlying transport instead of
 * just walking away from an unread promise. `logger`, if given, records a
 * debug line if `next()` still settles *after* the idle timeout already
 * rejected. `resolve`/`reject` on an already-settled promise is otherwise
 * a silent no-op, so without this the late chunk (possibly the final
 * usage chunk) would vanish with no trace.
 */
export function withChunkIdleTimeout<T>(
  next: () => Promise<IteratorResult<T>>,
  timeoutMs: number | undefined,
  onIdle?: () => void,
  logger?: Pick<Logger, 'debug'>,
): Promise<IteratorResult<T>> {
  const activeTimeoutMs = resolveActiveTimeoutMs(timeoutMs);

  if (activeTimeoutMs === undefined) {
    return next();
  }

  let settled = false;

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      onIdle?.();
      reject(
        new LLMError(
          `No stream chunk received for ${activeTimeoutMs}ms (idle timeout)`,
          'timeout',
          {
            code: 'idle_timeout',
          },
        ),
      );
    }, clampTimeoutMs(activeTimeoutMs));

    next().then(
      (result) => {
        clearTimeout(timer);
        if (settled) {
          logger?.debug('[VernLLM] chunk resolved after idle timeout already fired; discarding');
          return;
        }
        settled = true;
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (settled) {
          logger?.debug(
            '[VernLLM] chunk rejection arrived after idle timeout already fired; discarding',
          );
          return;
        }
        settled = true;
        reject(error);
      },
    );
  });
}

type HeaderKind = 'ms' | 'seconds' | 'date';

/**
 * Header names checked, in order, when looking for provider retry timing.
 * The millisecond forms are checked first since they carry finer
 * granularity than the standard header allows. Retry After itself is
 * checked twice, once as a delta seconds value and once as an HTTP date,
 * since both forms use the same header name.
 */
const RETRY_AFTER_CANDIDATES: { name: string; kind: HeaderKind }[] = [
  { name: 'Retry-After-Ms', kind: 'ms' },
  { name: 'X-Retry-After-Ms', kind: 'ms' },
  { name: 'Retry-After', kind: 'seconds' },
  { name: 'Retry-After', kind: 'date' },
];

/**
 * Reads a single header value off either a Headers-like object (has
 * `.get()`, called with the canonical casing above, since a real Headers
 * object is case insensitive) or a plain object (axios style, matched
 * case insensitively here instead since the object itself is not).
 */
function readHeader(headers: object, name: string): string | undefined {
  const getter = headers as { get?: (n: string) => string | null };

  if (typeof getter.get === 'function') {
    return getter.get(name) ?? undefined;
  }

  const match = Object.entries(headers as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];

  return typeof match === 'string' ? match : undefined;
}

/**
 * A value below 0 means the header told us nothing usable, a malformed
 * negative delta or a date already in the past, so it is treated the same
 * as a header that failed to parse at all rather than as an immediate 0ms
 * retry against a provider that just asked us to slow down.
 */
function clampOrUndefined(rawMs: number, maxDelayMs: number): number | undefined {
  return rawMs < 0 ? undefined : Math.min(rawMs, maxDelayMs);
}

/**
 * Looks inside an unknown error value for provider retry timing and
 * converts it to milliseconds. Checks a small set of known millisecond
 * headers first (some providers, Bedrock included, surface these for
 * finer granularity than the standard header allows), then falls back to
 * the standard Retry After header in both its delta seconds form ("30")
 * and its HTTP date form ("Wed, 21 Oct 2015 07:28:00 GMT").
 *
 * Checks `.headers` first (fetch style, Headers like with `.get()`), then
 * `.response.headers` (axios style, plain object), since different client
 * libraries surface headers differently.
 *
 * The result is capped at maxDelayMs. A header that parses to a negative
 * value, a negative delta or a date already in the past, is treated as
 * absent rather than clamped to 0, since it gave no usable timing.
 * Returns undefined when no usable value is present.
 */
export function extractRetryAfterMs(
  err: unknown,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const error = err as { headers?: unknown; response?: { headers?: unknown } };
  const headers = error.headers ?? error.response?.headers;

  if (!headers || typeof headers !== 'object') return undefined;

  for (const { name, kind } of RETRY_AFTER_CANDIDATES) {
    const raw = readHeader(headers, name)?.trim();
    if (!raw) continue;

    if (kind === 'ms' && /^\d+$/.test(raw)) {
      return clampOrUndefined(Number(raw), maxDelayMs);
    }

    if (kind === 'seconds' && /^\d+(\.\d+)?$/.test(raw)) {
      return clampOrUndefined(Number(raw) * 1000, maxDelayMs);
    }

    if (kind === 'date') {
      const dateMs = Date.parse(raw);
      if (!Number.isNaN(dateMs)) return clampOrUndefined(dateMs - Date.now(), maxDelayMs);
    }
  }

  return undefined;
}

/**
 * Applies full jitter to a capped exponential value: picks uniformly
 * over `[0, exp]`. Shared by `getBackoffDelay` (retry backoff) and the
 * circuit breaker's cooldown backoff shorthand, since both compute a
 * capped exponential value and then jitter it the same way. See AWS's
 * backoff and jitter writeup for why full jitter is used.
 */
export function fullJitter(exp: number): number {
  return Math.random() * exp;
}

/**
 * Exponential backoff with full jitter, capped at maxDelayMs. See AWS's
 * backoff and jitter writeup for why full jitter is used.
 *
 * rateLimited and serverError each default to false, so a caller who
 * passes neither gets exactly today's curve. A rate-limited response
 * (429) with no explicit Retry After backs off hardest. A server error
 * (5xx) backs off more than the default curve but less than a
 * rate-limited response. If both are true, rateLimited wins.
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

/**
 * Pauses execution for the given delay before a retry attempt. If an
 * abort signal is provided and it fires while waiting, the pending
 * timer is cancelled immediately and the wait rejects right away with
 * an aborted error instead of continuing to sit idle until the delay
 * would have finished on its own
 */
export async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new LLMError('Operation aborted', 'aborted');
  }

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
 * Waits out the backoff delay for a retry attempt, honoring a Retry-After
 * header on the failed attempt's error when present. When no Retry-After
 * is present, a rate-limited (429) response backs off hardest, a server
 * error (500 through 599) backs off somewhat more than the default curve,
 * and every other retryable failure keeps the default curve. Both
 * Retry-After and plain exponential backoff are capped at the same max
 * delay (see `DEFAULT_MAX_DELAY_MS` above).
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
    middleware,
    middlewareTimeoutMs,
    logger,
    reportEvent,
    buildEventContext,
    extractStatus,
    normalizeError,
    emitEvent,
  } = params;

  const retryAfterMs = extractRetryAfterMs(error);
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
 * Runs `fn`, retrying with backoff. When `attempts` is given, every
 * failed attempt that was retried past gets recorded in order, as an
 * `LLMError.toSnapshot()`. The terminal failure is never pushed since
 * it's the thrown error itself. `shouldRetryAttempt`/`recoverDelayForAttempt`
 * are params so callers can close over their own target specific context.
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

export async function retryWithBackoff<T>(params: RetryWithBackoffParams<T>): Promise<T> {
  const {
    fn,
    maxRetries,
    signal,
    onAttempt,
    attempts,
    shouldRetryAttempt,
    recoverDelayForAttempt,
    normalizeError,
  } = params;

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
