/**
 * Throws `RangeError` unless `value` is a non-negative integer: the calls needed in the window
 * before a ratio is judged. `0` applies the check at once.
 */
export function validateMinCalls(value: number, label = 'minCalls'): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Throws `RangeError` unless `value` is a finite fraction in `[0, 1]`. Anything else would always
 * or never trip.
 */
export function validateRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number between 0 and 1, got ${value}`);
  }
}
