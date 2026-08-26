import type { LLMError } from './errors.js';
import type { MiddlewareContext, VernLLMMiddleware } from './middleware.js';

/**
 * `VernLLMMiddleware` plus `onError`, a convenience for the common "I
 * only care about failures" case. Everything else is passed through to
 * the resulting `VernLLMMiddleware` unchanged; setting `wrap` directly
 * alongside `onError` is an error, since `onError` builds its own `wrap`
 * under the hood, and building it around a `wrap` you also supplied
 * would silently drop one of the two.
 */
export type CreateMiddlewareOptions = Omit<VernLLMMiddleware, 'wrap'> & {
  wrap?: undefined;
  /**
   * Called with this call's terminal error, if it fails: the same error
   * `wrap`'s own `next()` would reject with. Never called on success,
   * and never called for a failure some *other* middleware's `wrap`
   * already swallowed by short-circuiting with its own `CallResult`.
   * The original error is always rethrown afterward, `onError` only
   * observes it, exactly like `onUsage`/`onEvent` elsewhere: a throwing
   * `onError` is discarded (not logged, this helper has no `Logger` of
   * its own to log through) and otherwise has no effect on the call.
   */
  onError?: (error: LLMError, ctx: MiddlewareContext) => void | Promise<void>;
};

/**
 * Builds a `VernLLMMiddleware` entry. Plain pass-through when `onError`
 * is omitted; when it's set, wraps it in a `wrap` that calls `next()`,
 * reports `onError` on a rejection, and always rethrows the original
 * error afterward, so `onError` never changes what the call itself
 * returns or throws, only what gets observed about it.
 */
export function createMiddleware(options: CreateMiddlewareOptions): VernLLMMiddleware {
  const { onError, ...rest } = options;

  if (!onError) return rest;

  return {
    ...rest,
    wrap: async (_request, next, ctx) => {
      try {
        return await next();
      } catch (error) {
        try {
          await onError(error as LLMError, ctx);
        } catch {
          // onError is fire-and-forget, matching onUsage/onEvent: a
          // throwing observer never masks (or replaces) the real error
          // below.
        }
        throw error;
      }
    },
  };
}
