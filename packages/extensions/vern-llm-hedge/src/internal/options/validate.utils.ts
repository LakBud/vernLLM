export function invalid(message: string): never {
  throw new Error(`hedgeMiddleware: ${message}`);
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPositive(value: unknown): value is number {
  return isNumber(value) && value > 0;
}
