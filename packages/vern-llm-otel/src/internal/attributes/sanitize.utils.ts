import type { Attributes, AttributeValue } from '@opentelemetry/api';

/**
 * Keeps only what OpenTelemetry can carry from a user supplied bag: strings, finite numbers,
 * booleans, and arrays of a single one of those. Everything else is dropped rather than
 * stringified, so an object with a secret in it never becomes an attribute by accident.
 */
export function sanitizeAttributes(value: unknown): Attributes {
  const attrs: Attributes = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return attrs;

  for (const [key, item] of Object.entries(value)) {
    if (key === '') continue;
    const safe = toAttributeValue(item);
    if (safe !== undefined) attrs[key] = safe;
  }

  return attrs;
}

function toAttributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;

  if (value.every((item) => typeof item === 'string')) return value as string[];
  if (value.every((item) => typeof item === 'boolean')) return value as boolean[];
  if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return value as number[];
  }
  return undefined;
}
