import { InMemoryCacheAdapter, type CacheAdapter, type EvictionOption } from '../../types/cache.js';

/**
 * Not exported. Internal shorthand for `VernLLMOptions.cache`, so the
 * union isn't duplicated between that field and `buildCache`'s own
 * signature. A caller never writes this type by name, either a config
 * object literal or a real `CacheAdapter`.
 */
export type CacheOption = { maxSize?: number; eviction?: EvictionOption } | CacheAdapter;

/** A config object has neither `get` nor `set`, a `CacheAdapter` always has both. */
function isCacheAdapter(option: CacheOption): option is CacheAdapter {
  const candidate = option as CacheAdapter;
  return typeof candidate.get === 'function' && typeof candidate.set === 'function';
}

/** Resolves `VernLLMOptions.cache` into a real `CacheAdapter`. Same placement reasoning as `buildCircuitBreaker`: a construction time concern of `VernLLM`, not the adapter itself. */
export function buildCache(option: CacheOption | undefined): CacheAdapter {
  if (option === undefined) return new InMemoryCacheAdapter();
  if (isCacheAdapter(option)) return option;

  if (
    option.maxSize !== undefined &&
    (!Number.isFinite(option.maxSize) || option.maxSize < 0 || !Number.isInteger(option.maxSize))
  ) {
    throw new RangeError(
      `cache.maxSize must be a finite, non-negative integer, got ${String(option.maxSize)}`,
    );
  }

  return new InMemoryCacheAdapter(option.maxSize, option.eviction);
}
