import type { CachedCallParams, CallParams } from './types/index.js';

/**
 * Keeps `params`' precise type for a reusable variable. A `CallParams<T>` annotation would widen
 * `tools` and lose the conditional tools overload. Pin `T` through `llm.call<T>(params)`.
 */
export function defineCallParams<P extends CallParams<unknown>>(params: P): P {
  return params;
}

/**
 * `cachedCall()` counterpart to `defineCallParams`, keeping the whole `{ cacheKey, ttl, call }`
 * type.
 */
export function defineCachedCallParams<P extends CachedCallParams<unknown>>(params: P): P {
  return params;
}
