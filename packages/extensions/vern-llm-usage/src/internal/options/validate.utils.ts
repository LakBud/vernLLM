export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function optionalFunction(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new Error(`usageMiddleware: ${name} must be a function`);
  }
}

/** A finite number of at least zero, as a price or a rate must be. */
export function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`usageMiddleware: ${name} must be a finite number >= 0`);
  }
  return value;
}

/** A finite number above zero. Not `??`, since an explicit `null` is a mistake to report. */
export function positiveNumber(value: unknown, name: string, fallback: number): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`usageMiddleware: ${name} must be a positive number`);
  }
  return resolved;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `pricesAsOf` as epoch ms: a real `YYYY-MM-DD` that is not in the future, as UTC midnight. */
export function parsePricesAsOf(value: unknown): number {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error('usageMiddleware: pricesAsOf must be an ISO date such as 2026-10-01');
  }

  const ms = Date.parse(value);
  // `Date.parse` rolls 2026-02-31 into March, so compare it back.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error('usageMiddleware: pricesAsOf must be an ISO date such as 2026-10-01');
  }
  if (ms > Date.now()) {
    throw new Error('usageMiddleware: pricesAsOf must not be in the future (UTC)');
  }
  return ms;
}
