import { LLMError } from 'vern-llm';

/**
 * Throws `LLMError('invalid_params')` with no `code`: the message already
 * names the exact problem, and a caller has nothing to branch on beyond
 * the type.
 */
export function invalidParams(message: string): never {
  throw new LLMError(message, 'invalid_params');
}

/** Rejects `NaN`, `Infinity` and negatives. `0` passes, since it is a meaningful "off" or "unlimited" for several options. */
export function assertNonNegativeFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    invalidParams(`${name} must be a finite number that is not negative (got ${value}).`);
  }
}

/** Rejects `NaN`, `Infinity`, `0` and negatives, for durations where `0` would spin or expire instantly. */
export function assertPositiveFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    invalidParams(`${name} must be a finite number greater than 0 (got ${value}).`);
  }
}

export function assertNonNegativeInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    invalidParams(`${name} must be a non-negative integer (got ${value}).`);
  }
}
