export function invalid(message: string): never {
  throw new Error(`policyMiddleware: ${message}`);
}
