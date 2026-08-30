import { InMemoryCacheAdapter, type CacheAdapter, type EvictionOption } from '../../types/cache.js';

/**
 * Not exported. Internal shorthand for `VernLLMOptions.cache`, so the
 * union isn't duplicated between that field and `buildCache`'s own
 * signature. A caller never writes this type by name, either a config
 * object literal or a real `CacheAdapter`.
 */
export type CacheOption = { maxSize?: number; eviction?: EvictionOption } | CacheAdapter;

/** A config object has no `get` method, a `CacheAdapter` always does. */
function isCacheAdapter(option: CacheOption): option is CacheAdapter {
  return typeof (option as CacheAdapter).get === 'function';
}

/** Resolves `VernLLMOptions.cache` into a real `CacheAdapter`. Same placement reasoning as `buildCircuitBreaker`: a construction time concern of `VernLLM`, not the adapter itself. */
export function buildCache(option: CacheOption | undefined): CacheAdapter {
  if (option === undefined) return new InMemoryCacheAdapter();
  if (isCacheAdapter(option)) return option;

  return new InMemoryCacheAdapter(option.maxSize, option.eviction);
}
