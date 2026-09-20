/** Monotonic clock, so a wall clock adjustment can never produce a negative duration. */
export function nowMs(): number {
  return performance.now();
}

/**
 * Milliseconds from `startMs` to `endMs`, minus time spent waiting locally (rate limit queue),
 * so the result measures the provider and not our own queueing. Never negative and never NaN.
 */
export function elapsedMs(startMs: number, waitedMs = 0, endMs: number = nowMs()): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  const waited = Number.isFinite(waitedMs) && waitedMs > 0 ? waitedMs : 0;
  return Math.max(0, endMs - startMs - waited);
}
