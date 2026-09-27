import { LLMError } from '../../../../types/errors.js';
import { MAX_TIMER_DELAY_MS } from '../deadline.utils.js';

import type { Logger } from '../../../../logger.js';

// `setTimeout` clamps anything above MAX_TIMER_DELAY_MS, or Infinity, to about 1ms,
// so the helpers below treat those as no timeout rather than an instant one.

/**
 * The delay `setTimeout` should use, or `undefined` when the timeout is off (0, negative or
 * `Infinity`).
 */
export function resolveActiveTimeoutMs(ms: number | undefined): number | undefined {
  return !ms || ms <= 0 || ms === Infinity ? undefined : ms;
}

/** Caps a timeout at the largest delay `setTimeout` actually honors. */
export function clampTimeoutMs(ms: number): number {
  return Math.min(ms, MAX_TIMER_DELAY_MS);
}

/**
 * Runs `fn` with a timeout, joined with any external signal. The call is raced against the timer,
 * so a client that ignores the signal still times out. After the timer fires any error becomes
 * `LLMError('timeout')`; an external abort stays `aborted`. `Infinity`, or any value past the timer
 * range, disables the timeout.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();

  const activeTimeoutMs = resolveActiveTimeoutMs(timeoutMs);

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;

  const timeoutError = () =>
    new LLMError('Request timed out', 'timeout', { code: 'request_timeout' });

  let timer: ReturnType<typeof setTimeout> | undefined;

  // Raced against `fn`, so a client that ignores the signal still times out.
  const timeoutPromise = new Promise<never>((_, reject) => {
    if (activeTimeoutMs === undefined) return;

    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, clampTimeoutMs(activeTimeoutMs));
  });

  try {
    return await Promise.race([fn(signal), timeoutPromise]);
  } catch (err) {
    // Any error raised after the internal timer fired counts as a timeout,
    // whatever abort error type the client threw. External aborts propagate.
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw err instanceof LLMError && err.type === 'timeout' ? err : timeoutError();
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Races one `iterator.next()` against an idle timer, bounding the gap between chunks, measured from
 * the latest chunk. Rejects with `LLMError('timeout')`; 0, undefined or `Infinity` disable it.
 * `onIdle` fires first so the transport can be aborted. `logger` records a `next()` that settles
 * after the timeout, since that late chunk, possibly usage, would otherwise vanish.
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
