import { ttlToPx } from './internal/ttl.utils.js';

import type { RedisClient } from './types.js';
import type { CacheAdapter } from 'vern-llm';

export interface RedisCacheOptions {
  /** Prefix for every key. Default "vernllm:cache". */
  keyPrefix?: string;
}

/** A CacheAdapter backed by Redis, shared by every process. */
export function redisCache<T = unknown>(
  redis: RedisClient,
  options: RedisCacheOptions = {},
): CacheAdapter<T> {
  const keyPrefix = options.keyPrefix ?? 'vernllm:cache';

  function fullKey(key: string): string {
    return `${keyPrefix}:${key}`;
  }

  return {
    async get(key) {
      const raw = await redis.get(fullKey(key));
      if (raw === null) return { hit: false, value: null };

      try {
        return { hit: true, value: JSON.parse(raw) as T };
      } catch {
        // A corrupt entry is a miss, never an error.
        return { hit: false, value: null };
      }
    },

    async set(key, value, ttl) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new TypeError(
          `redisCache: value for key "${key}" is not JSON-serializable (got undefined, a function, or a symbol)`,
        );
      }

      // A spent TTL expires on arrival, as in InMemoryCacheAdapter.
      const px = ttlToPx(ttl);
      if (px === undefined) {
        await redis.del(fullKey(key));
        return;
      }

      await redis.set(fullKey(key), serialized, 'PX', px);
    },

    async delete(key) {
      await redis.del(fullKey(key));
    },
  };
}
