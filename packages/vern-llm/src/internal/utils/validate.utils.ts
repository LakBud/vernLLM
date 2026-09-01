/**
 * Throws `RangeError` unless `value` is a non-negative integer. Shared by
 * `RetryBudget` and `RollingTripping`, whose own `minCalls` means the
 * same thing in both: how many calls must land in the trailing window
 * before the ratio check is judged meaningful at all. `0` is valid (the
 * check applies immediately); a negative or non-integer count can't
 * describe a real number of calls, so it's a config mistake worth
 * failing at construction rather than silently misbehaving later.
 */
export function validateMinCalls(value: number, label = 'minCalls'): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Throws `RangeError` unless `value` is a finite number in `[0, 1]`.
 * Shared by `RetryBudget`'s `retryRatio` and `RollingTripping`'s
 * `failureRatio`, both a fraction of calls in a window. A value outside
 * `[0, 1]` can never usefully compare against a real ratio (always
 * trips, or never does), so it's a config mistake worth failing at
 * construction rather than a silently degenerate policy.
 */
export function validateRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number between 0 and 1, got ${value}`);
  }
}
