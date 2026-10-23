export function invalid(message: string): never {
  throw new Error(`routerMiddleware: ${message}`);
}
