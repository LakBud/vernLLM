/** A timer handle from `setInterval`/`setTimeout`, typed loosely since Node returns an object and browsers a number. */
export type TimerHandle = ReturnType<typeof setInterval>;

/**
 * Stops a background timer from keeping a short lived process (a script, a
 * test, a serverless invocation) alive on its own. `unref` does not exist
 * in every environment (browsers), so it is guarded.
 */
export function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}
