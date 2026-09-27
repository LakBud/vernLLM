/** Monotonic clock, so a wall clock adjustment can never produce a negative duration. */
export function nowMs(): number {
  return performance.now();
}

/** Milliseconds from `startMs` to `endMs`. Never negative and never NaN. */
export function elapsedMs(startMs: number, endMs: number = nowMs()): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}
