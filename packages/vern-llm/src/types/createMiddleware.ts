import type { LLMError } from './errors.js';
import type { PreDispatchContext, VernLLMMiddleware } from './middleware.js';

/**
 * `VernLLMMiddleware` plus `onError`, for middleware that only cares about failures. `wrap` can't
 * be set alongside it, since `onError` builds its own.
 */
export type CreateMiddlewareOptions = Omit<VernLLMMiddleware, 'wrap'> & {
  wrap?: undefined;
  /**
   * Called with the call's terminal error. Not called on success or when another `wrap` swallowed
   * the failure. Only observes: the error is always rethrown and a throwing `onError` is discarded.
   * `ctx` is `wrap`'s pre-dispatch context.
   */
  onError?: (error: LLMError, ctx: PreDispatchContext) => void | Promise<void>;
};

/**
 * Builds a middleware entry. With `onError`, adds a `wrap` that reports rejections and always
 * rethrows, so the call's outcome never changes.
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
