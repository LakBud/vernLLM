import { describe, expect, it } from 'vitest';

import { buildCache } from '../../../../src/internal/utils/cacheAdapter.utils.js';
import { InMemoryCacheAdapter, TieredCacheAdapter } from '../../../../src/types/cache.js';

describe('buildCache', () => {
  it('defaults to a fresh InMemoryCacheAdapter when option is omitted', async () => {
    const cache = buildCache(undefined);

    expect(cache).toBeInstanceOf(InMemoryCacheAdapter);
    await cache.set('k', 'v', 60);
    expect((await cache.get('k')).value).toBe('v');
  });

  it('builds a configured InMemoryCacheAdapter from a plain config object', async () => {
    const cache = buildCache({ maxSize: 1, eviction: 'lru' });

    await cache.set('a', 'A', 60);
    await cache.set('b', 'B', 60);

    // maxSize 1 means 'a' was evicted when 'b' was inserted.
    expect((await cache.get('a')).hit).toBe(false);
    expect((await cache.get('b')).hit).toBe(true);
  });

  it('passes a hand built CacheAdapter through untouched, never re-wrapping it', () => {
    const custom = new TieredCacheAdapter(new InMemoryCacheAdapter(), new InMemoryCacheAdapter());

    expect(buildCache(custom)).toBe(custom);
  });

  it('passes a plain InMemoryCacheAdapter instance through as-is, not just config-shaped input', () => {
    const custom = new InMemoryCacheAdapter(5, 'lru');

    expect(buildCache(custom)).toBe(custom);
  });
});
