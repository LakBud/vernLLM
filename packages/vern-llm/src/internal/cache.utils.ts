import type { UsageHooks } from '../types/usage.js';

/**
 * Parameters for the private `fn`-based cache primitive backing the public
 * `cachedCall()`. Lives in `internal/`, not `types/`, so it's structurally
 * separate from the public API surface: `types/index.ts` never touches this
 * directory, so there's no wildcard export to accidentally forward it
 * through. Only `vernLLM.ts` (via `runCached`) uses this.
 *
 * `cacheKey` looks up existing results, `fn` runs only on cache misses, and
 * concurrent misses for the same key are coalesced into a single in-flight
 * operation.
 */
export interface InternalCacheParams<T> extends UsageHooks {
  cacheKey: string;
  ttl: number;
  fn: () => Promise<T>;
  signal?: AbortSignal;
}
