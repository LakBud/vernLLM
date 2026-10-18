import { LLMError } from 'vern-llm';

/** Throws `LLMError('invalid_params')` without a code. */
export function invalidParams(message: string): never {
  throw new LLMError(message, 'invalid_params');
}

/** Rejects NaN, Infinity and negatives. */
export function assertNonNegativeFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    invalidParams(`${name} must be a finite number that is not negative (got ${value}).`);
  }
}

/** Rejects NaN, Infinity, 0 and negatives. */
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

/**
 * Resolves an adapter's `keyPrefix`: `undefined` or `null` takes `fallback`, as `??` did before,
 * and anything but a non-empty string throws. Redis accepts any bytes in a key, so the content itself is not restricted.
 */
export function resolveKeyPrefix(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value === '') {
    invalidParams(
      `keyPrefix must be a non-empty string (got ${typeof value === 'string' ? '""' : String(value)}).`,
    );
  }
  return value;
}
