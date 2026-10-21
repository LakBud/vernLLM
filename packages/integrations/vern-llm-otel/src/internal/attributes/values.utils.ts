import type { Attributes, AttributeValue } from '@opentelemetry/api';

// Numbers are checked with Number.isFinite because provider usage and request fields are not
// guaranteed to be well formed.

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Writes `value` only when it is defined, so absent data never becomes an `undefined` attribute. */
export function put(target: Attributes, key: string, value: AttributeValue | undefined): void {
  if (value !== undefined) target[key] = value;
}
