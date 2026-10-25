import type { Scalar } from '../../types/options.js';

/** Keys a pattern uses itself, so no fact can be named one. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['not', 'any', 'gte', 'lte']);

export function isScalar(value: unknown): value is Scalar {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads an own property only, so `toString` or `constructor` can never be a fact. */
export function read(facts: unknown, key: string): unknown {
  if (typeof facts !== 'object' || facts === null) return undefined;
  return Object.hasOwn(facts, key) ? (facts as Record<string, unknown>)[key] : undefined;
}
