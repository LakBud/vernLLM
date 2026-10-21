/** A cache TTL in seconds as whole ms for `PX`, capped, or undefined when already spent. */
export function ttlToPx(ttlSeconds: unknown): number | undefined {
  if (typeof ttlSeconds !== 'number' || Number.isNaN(ttlSeconds) || ttlSeconds <= 0) {
    return undefined;
  }

  return Math.min(Math.max(1, Math.ceil(ttlSeconds * 1000)), Number.MAX_SAFE_INTEGER);
}
