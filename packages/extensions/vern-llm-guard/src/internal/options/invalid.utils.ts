/** A mistake in the options, thrown when the guard is built. */
export function invalid(message: string): never {
  throw new TypeError(`guardMiddleware: ${message}`);
}
