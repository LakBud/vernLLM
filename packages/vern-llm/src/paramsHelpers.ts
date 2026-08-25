import type { CachedCallParams, CallParams } from './types/index.js';

/**
 * Identity function preserving `params`'s own precise type, unlike a `:
 * CallParams<T>` annotation, which would widen `tools` away and break the
 * `ConditionalToolCallParams<T>` overload for `tools: someCondition ?
 * [tool] : undefined`. Use it when you need `call()` params in a named,
 * reusable variable; skip it when you can pass the object inline.
 *
 * ```ts
 * const params = defineCallParams({
 *   userContent: 'What is the weather?',
 *   tools: someCondition ? [weatherTool] : undefined,
 * });
 * const result = await llm.call(params);
 * // result: unknown | CallWithToolsResult<unknown>, same as inline
 * ```
 *
 * `T` isn't a parameter here; pin it via `llm.call<T>(params)` as usual.
 * `defineCachedCallParams` is the `cachedCall()` counterpart.
 */
export function defineCallParams<P extends CallParams<unknown>>(params: P): P {
  return params;
}

/**
 * The `cachedCall()` counterpart to `defineCallParams`: preserves the
 * whole `{ cacheKey, ttl, call }` object, `call.tools` included, in one
 * named variable.
 *
 * ```ts
 * const params = defineCachedCallParams({
 *   cacheKey: 'weather-ny',
 *   ttl: 60,
 *   call: { userContent: 'What is the weather?', tools: someCondition ? [weatherTool] : undefined },
 * });
 * const result = await llm.cachedCall(params);
 * ```
 */
export function defineCachedCallParams<P extends CachedCallParams<unknown>>(params: P): P {
  return params;
}
