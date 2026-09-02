import { LLMError } from '../../../types/errors.js';

/**
 * Identity, not a message: never read for its text, only compared by
 * reference in `stampDeadlineCode`, so it can't collide with a reason a
 * caller's own `AbortController` happens to use.
 */
export const DEADLINE_REASON = Symbol('deadlineExceeded');

/** The signal `call()` should actually use, and the timer to clear when done. */
export interface DeadlineSetup {
  signal: AbortSignal | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Composes `deadlineMs`/`deadlineAt` into a single `AbortSignal`, reusing
 * the same `AbortSignal.any` pattern `withTimeout` uses. Omitting both is
 * a no op: the caller's own signal passes through unchanged.
 *
 * `deadlineAt` wins if both are set. It converts to a remaining budget
 * by subtracting `Date.now()`; a deadline already in the past behaves
 * like `deadlineMs: 0`, failing fast without dispatching.
 */
export function setupDeadline(
  deadlineMs: number | undefined,
  callerSignal: AbortSignal | undefined,
  deadlineAt?: number,
): DeadlineSetup {
  const remaining = deadlineAt !== undefined ? deadlineAt - Date.now() : deadlineMs;

  if (remaining === undefined) {
    return { signal: callerSignal, timer: undefined };
  }

  const controller = new AbortController();

  // A deadline of 0 (or negative) means the budget is already spent. A
  // `setTimeout(fn, 0)` still queues a macrotask, so it wouldn't reliably
  // beat dispatch, the abort has to happen synchronously here instead, the
  // same way an already-aborted caller signal is treated as a fail-fast
  // case rather than raced.
  if (remaining <= 0) {
    controller.abort(DEADLINE_REASON);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    return { signal, timer: undefined };
  }

  const timer = setTimeout(() => controller.abort(DEADLINE_REASON), remaining);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;

  return { signal, timer };
}

/**
 * Fills in `code: 'deadline_exceeded'` on an already-normalized aborted
 * error, but only when the abort was actually caused by `deadlineMs`
 * elapsing rather than a caller-supplied signal firing first, and only
 * when the error doesn't already carry a code. Mirrors the same fill-in
 * pattern `normalizeError` already uses for `status` to `code`, applied
 * one layer up, at the whole call level instead of the single attempt
 * level.
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
