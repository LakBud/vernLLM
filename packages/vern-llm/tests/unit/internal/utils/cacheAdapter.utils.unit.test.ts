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

  it('builds a configured InMemoryCacheAdapter with lru eviction, distinguishing it from fifo', async () => {
    const cache = buildCache({ maxSize: 2, eviction: 'lru' });

    await cache.set('a', 'A', 60);
    await cache.set('b', 'B', 60);
    // Reading 'a' marks it as recently used, so 'b' becomes the eviction victim instead.
    await cache.get('a');
    await cache.set('c', 'C', 60);

    expect((await cache.get('a')).hit).toBe(true);
    expect((await cache.get('b')).hit).toBe(false);
  });

  it('passes a hand built CacheAdapter through untouched, never re-wrapping it', () => {
    const custom = new TieredCacheAdapter(new InMemoryCacheAdapter(), new InMemoryCacheAdapter());

    expect(buildCache(custom)).toBe(custom);
  });

  it('passes a plain InMemoryCacheAdapter instance through as-is, not just config-shaped input', () => {
    const custom = new InMemoryCacheAdapter(5, 'lru');

    expect(buildCache(custom)).toBe(custom);
  });

  it('rejects an invalid maxSize before constructing the adapter', () => {
    expect(() => buildCache({ maxSize: Number.NaN })).toThrow(RangeError);
    expect(() => buildCache({ maxSize: Infinity })).toThrow(RangeError);
    expect(() => buildCache({ maxSize: -1 })).toThrow(RangeError);
    expect(() => buildCache({ maxSize: 1.5 })).toThrow(RangeError);
  });

  it('accepts a valid maxSize, including the boundary case of 0', async () => {
    expect(() => buildCache({ maxSize: 0 })).not.toThrow();

    const cache = buildCache({ maxSize: 10 });
    await cache.set('k', 'v', 60);
    expect((await cache.get('k')).value).toBe('v');
  });
});
