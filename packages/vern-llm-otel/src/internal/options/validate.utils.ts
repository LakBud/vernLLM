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
