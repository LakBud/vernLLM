/** A `setInterval` or `setTimeout` handle. */
export type TimerHandle = ReturnType<typeof setInterval>;

/** Lets a background timer not keep the process alive, where `unref` exists. */
export function unrefTimer(timer: TimerHandle): void {
  (timer as { unref?: () => void }).unref?.();
}
