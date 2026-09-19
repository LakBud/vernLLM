/**
 * Converts a cache TTL in seconds to the positive integer of milliseconds
 * Redis's `PX` accepts, or `undefined` when the TTL is already spent (0,
 * negative, `NaN`, not a number), meaning "expired on arrival".
 *
 * A sub millisecond TTL rounds up rather than to 0, and `Infinity` (or any
 * absurd value) is capped at what Redis can add to the current time.
 */
export function ttlToPx(ttlSeconds: unknown): number | undefined {
  if (typeof ttlSeconds !== 'number' || Number.isNaN(ttlSeconds) || ttlSeconds <= 0) {
    return undefined;
  }

  return Math.min(Math.max(1, Math.ceil(ttlSeconds * 1000)), Number.MAX_SAFE_INTEGER);
}
