import type { StreamChunk } from '../../../types/stream.js';
import type { UsageHooks } from '../../../types/usage.js';

/**
 * Parameters for the caching core behind `cachedCall()`. Internal, so it can't leak into the public
 * types. `fn` runs only on a miss and receives the shared signal, which fires once every coalesced
 * caller has left; `signal` ends only this caller's wait.
 */
export interface InternalCacheParams<T> extends UsageHooks {
  cacheKey: string;
  ttl: number;
  fn: (sharedSignal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
}

/**
 * Streaming counterpart to `InternalCacheParams`: `openStream` opens a live stream instead of
 * returning one value.
 */
export interface InternalCacheStreamParams<T> extends UsageHooks {
  cacheKey: string;
  ttl: number;
  openStream: (
    sharedSignal: AbortSignal,
  ) => Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> }>;
  signal?: AbortSignal;
}
