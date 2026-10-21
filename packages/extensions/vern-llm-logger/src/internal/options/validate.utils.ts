const PREFIX = 'loggerMiddleware';

export function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

// A plain boolean on purpose: as a type predicate it narrows the typed options to `{}`.
export function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'boolean') fail(`${name} must be a boolean`);
}

export function optionalFunction(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'function') fail(`${name} must be a function`);
}

export function optionalObject(value: unknown, name: string): void {
  if (value !== undefined && !isPlainObject(value)) fail(`${name} must be an object`);
}

/** A finite number strictly greater than zero, or `fallback` when absent. */
export function positiveNumber(value: unknown, name: string, fallback: number): number;
export function positiveNumber(
  value: unknown,
  name: string,
  fallback?: undefined,
): number | undefined;
export function positiveNumber(
  value: unknown,
  name: string,
  fallback?: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a positive number`);
  }
  return value;
}

export function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer`);
  }
  return value;
}

/** A number strictly between 0 and 1, the range a quantile can take. */
export function quantile(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    fail(`${name} must be a number between 0 and 1, exclusive`);
  }
  return value;
}

export function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) fail(`${name} must be an array of strings`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`${name} must contain only non empty strings`);
    }
  }
  return [...new Set(value as string[])];
}
