import { LLMError } from '../../../types/errors.js';

import type { CircuitBreakerAdapter, CircuitBreakerCallContext } from '../../../circuitBreaker.js';
import type { Logger } from '../../../logger.js';

/** How long `VernLLM` waits for a breaker's `prepare` when the adapter declares no `prepareTimeoutMs`, in ms. */
export const DEFAULT_PREPARE_TIMEOUT_MS = 1000;

/** A breaker known to have `prepare`, so it can be called on the adapter itself and keep its `this`. */
export type PreparableBreaker = CircuitBreakerAdapter &
  Required<Pick<CircuitBreakerAdapter, 'prepare'>>;

type PrepareOutcome = 'ready' | 'timeout' | 'aborted' | { failed: unknown };

/**
 * Awaits `breaker.prepare` so the synchronous `assertClosed` that follows
 * decides against fresh data, without ever letting a slow or broken
 * `prepare` block or fail the call it was meant to help.
 *
 * A rejection, a synchronous throw, or running past the timeout is
 * logged as a warning and the call carries on with whatever the adapter
 * already knows locally. The one exception is the call's own abort
 * signal: an aborted call stops waiting at once and rejects with
 * `aborted`, like every other place a call can be cancelled.
 *
 * Whichever way it ends, the timer and the abort listener are removed,
 * and a `prepare` that rejects after losing the race is still handled, so
 * it can never surface as an unhandled rejection.
 */
export async function runPrepare(
  breaker: PreparableBreaker,
  model: string,
  context: CircuitBreakerCallContext | undefined,
  logger: Logger,
): Promise<void> {
  const signal = context?.signal;
  if (signal?.aborted) throw new LLMError('Circuit breaker check aborted', 'aborted');

  const timeoutMs = breaker.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;

  let pending: Promise<void>;
  try {
    pending = Promise.resolve(breaker.prepare(model, context));
  } catch (error) {
    warnFailed(logger, error);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const outcome = await Promise.race<PrepareOutcome>([
    // Handles a rejection here, so a late one from a `prepare` that lost
    // the race below is never left unhandled.
    pending.then(
      () => 'ready' as const,
      (failed: unknown) => ({ failed }),
    ),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
    new Promise<'aborted'>((resolve) => {
      if (!signal) return;
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      // `prepare` may have aborted the signal synchronously, before the listener existed.
      if (signal.aborted) onAbort();
    }),
  ]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });

  if (outcome === 'aborted') throw new LLMError('Circuit breaker check aborted', 'aborted');

  if (outcome === 'timeout') {
    logger.warn(
      `[VernLLM] circuitBreaker.prepare took longer than ${timeoutMs}ms, continuing with the adapter's local state`,
    );
  } else if (outcome !== 'ready') {
    warnFailed(logger, outcome.failed);
  }
}

function warnFailed(logger: Logger, error: unknown): void {
  logger.warn(
    `[VernLLM] circuitBreaker.prepare failed, continuing with the adapter's local state: ${error instanceof Error ? error.message : String(error)}`,
  );
}
