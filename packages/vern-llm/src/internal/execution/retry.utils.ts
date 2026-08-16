import { LLMError } from '../../types/errors.js';

import type { Logger } from '../../logger.js';

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
