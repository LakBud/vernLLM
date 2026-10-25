import { RESERVED_KEYS, isPlainObject } from './value.utils.js';

/** The fact names a pattern reads at its top level, through `not` and `any`. */
export function patternKeys(pattern: unknown): string[] {
  if (!isPlainObject(pattern)) return [];

  return Object.entries(pattern).flatMap(([key, value]) => {
    if (key === 'not') return patternKeys(value);
    if (key === 'any') return Array.isArray(value) ? value.flatMap(patternKeys) : [];
    return RESERVED_KEYS.has(key) ? [] : [key];
  });
}
