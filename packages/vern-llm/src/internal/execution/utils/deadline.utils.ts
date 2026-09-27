import { LLMError } from '../../../types/errors.js';

/**
 * Identity, not a message: never read for its text, only compared by
 * reference in `stampDeadlineCode`, so it can't collide with a reason a
 * caller's own `AbortController` happens to use.
 */
export const DEADLINE_REASON = Symbol('deadlineExceeded');

/** Largest delay `setTimeout` honors (2^31 - 1 ms, about 24.8 days). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The signal `call()` should actually use, and the timer to clear when done. */
export interface DeadlineSetup {
  signal: AbortSignal | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Joins `deadlineMs` into one signal the rest of `call()` treats like the caller's own. Without a
 * deadline the caller's signal passes through and no timer is created.
 */
export function setupDeadline(
  deadlineMs: number | undefined,
  callerSignal: AbortSignal | undefined,
): DeadlineSetup {
  // setTimeout clamps anything above MAX_TIMER_DELAY_MS (and NaN) to about
  // 1ms, so an unbounded or out of range deadline would abort almost
  // immediately. Infinity and anything past the timer range mean no
  // deadline; NaN is treated the same as omitting it.
  if (deadlineMs === undefined || Number.isNaN(deadlineMs) || deadlineMs > MAX_TIMER_DELAY_MS) {
    return { signal: callerSignal, timer: undefined };
  }

  const controller = new AbortController();

  // A deadline of 0 (or negative) means the budget is already spent. A
  // `setTimeout(fn, 0)` still queues a macrotask, so it wouldn't reliably
  // beat dispatch, the abort has to happen synchronously here instead, the
  // same way an already-aborted caller signal is treated as a fail-fast
  // case rather than raced.
  if (deadlineMs <= 0) {
    controller.abort(DEADLINE_REASON);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    return { signal, timer: undefined };
  }

  const timer = setTimeout(() => controller.abort(DEADLINE_REASON), deadlineMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;

  return { signal, timer };
}

/**
 * Sets `code: 'deadline_exceeded'` on an aborted error without a code, only when the deadline
 * caused the abort rather than the caller's signal.
 */
export function stampDeadlineCode(error: unknown, signal: AbortSignal | undefined): unknown {
  if (
    error instanceof LLMError &&
    error.type === 'aborted' &&
    error.code === undefined &&
    signal?.reason === DEADLINE_REASON
  ) {
    error.code = 'deadline_exceeded';
  }

  return error;
}
