import type { RedisClient } from './types.js';
import type { CacheAdapter } from 'vern-llm';

export interface RedisCacheOptions {
  /** Prefix for every Redis key this adapter writes. Default "vernllm:cache". */
  keyPrefix?: string;
}

/**
 * A CacheAdapter backed by Redis. Matches vern-llm's own CacheAdapter
 * interface directly, drop it in wherever InMemoryCacheAdapter is used
 * today for a cache shared across every process.
 */
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
        // A corrupted or foreign value under this key is treated as a
        // miss rather than thrown, since a bad cache entry should never
        // break the call it was meant to speed up.
        return { hit: false, value: null };
      }
    },

    async set(key, value, ttl) {
      await redis.set(fullKey(key), JSON.stringify(value), 'PX', ttl * 1000);
    },

    async delete(key) {
      await redis.del(fullKey(key));
    },
  };
}
