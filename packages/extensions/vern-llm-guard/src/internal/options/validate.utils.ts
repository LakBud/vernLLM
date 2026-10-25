import { invalid } from './invalid.utils.js';
import { oneOf } from './settings.utils.js';

/** A non empty string. */
export function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${at} must be a non empty string`);
  return value;
}

/** `value`, or `fallback` when it is absent, and one of `allowed` either way. */
export function choice<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly string[],
  at: string,
): T {
  const picked = value ?? fallback;
  if (typeof picked !== 'string' || !allowed.includes(picked)) {
    invalid(`${at} must be ${oneOf(allowed)}`);
  }
  return picked as T;
}

/** A function when present. */
export function optionalFunction(value: unknown, at: string): void {
  if (value !== undefined && typeof value !== 'function') invalid(`${at} must be a function`);
}

/** A boolean when present. */
export function optionalBoolean(value: unknown, at: string): void {
  if (value !== undefined && typeof value !== 'boolean') invalid(`${at} must be true or false`);
}

/** An integer of at least `min`, with `fallback` for an absent value. */
export function integerAtLeast(value: unknown, fallback: number, min: number, message: string) {
  const picked = value ?? fallback;
  if (typeof picked !== 'number' || !Number.isInteger(picked) || picked < min) invalid(message);
  return picked;
}
