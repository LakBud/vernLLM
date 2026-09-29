export function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`otelMiddleware: ${name} must be a boolean`);
  }
}

export function optionalFunction(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new Error(`otelMiddleware: ${name} must be a function`);
  }
}

/**
 * A `maxLength` option: a positive integer or `Infinity`, or `fallback` when absent. Not `??`,
 * since an explicit `null` is a mistake to report rather than a request for the default.
 */
export function resolveMaxLength(value: unknown, name: string, fallback: number): number {
  const resolved = value === undefined ? fallback : value;
  const valid =
    typeof resolved === 'number' &&
    (resolved === Number.POSITIVE_INFINITY || (Number.isInteger(resolved) && resolved > 0));

  if (!valid) throw new Error(`otelMiddleware: ${name} must be a positive integer or Infinity`);

  return resolved;
}
