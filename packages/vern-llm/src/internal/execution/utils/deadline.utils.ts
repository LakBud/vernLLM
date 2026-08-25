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
 * Composes `deadlineMs` into a single `AbortSignal` the rest of `call()`
 * can treat exactly like a caller-supplied one, reusing the same
 * `AbortSignal.any` pattern `withTimeout` already uses to combine an
 * internal timeout with an external signal. When `deadlineMs` is omitted,
 * this is a no-op: the caller's own `signal` (or `undefined`) passes
 * straight through, and no controller or timer is created.
 */
export function setupDeadline(
  deadlineMs: number | undefined,
  callerSignal: AbortSignal | undefined,
): DeadlineSetup {
  if (deadlineMs === undefined) {
    return { signal: callerSignal, timer: undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(DEADLINE_REASON), deadlineMs);
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
