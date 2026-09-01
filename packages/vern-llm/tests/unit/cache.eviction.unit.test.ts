import { describe, expect, it } from 'vitest';

import { InMemoryCacheAdapter } from '../../src/types/cache.js';

describe('InMemoryCacheAdapter, default eviction (fifo)', () => {
  it('evicts the oldest inserted key once maxSize is exceeded', async () => {
    const cache = new InMemoryCacheAdapter<string>(2);

    await cache.set('a', 'A', 60);
    await cache.set('b', 'B', 60);
    await cache.set('c', 'C', 60);

    expect((await cache.get('a')).hit).toBe(false);
    expect((await cache.get('b')).hit).toBe(true);
    expect((await cache.get('c')).hit).toBe(true);
  });

  it('evicts by insertion order even when an old entry was read recently', async () => {
    const cache = new InMemoryCacheAdapter<string>(2, 'fifo');

    await cache.set('a', 'A', 60);
    await cache.set('b', 'B', 60);
    // A read of 'a' does not protect it under fifo, unlike lru.
    await cache.get('a');
    await cache.set('c', 'C', 60);

    expect((await cache.get('a')).hit).toBe(false);
    expect((await cache.get('b')).hit).toBe(true);
  });
});

describe('InMemoryCacheAdapter, lru eviction', () => {
  it('protects a recently read entry from eviction that fifo would not', async () => {
    const cache = new InMemoryCacheAdapter<string>(2, 'lru');

    await cache.set('a', 'A', 60);
    await cache.set('b', 'B', 60);
    // Reading 'a' marks it as recently used, so 'b' is the least recently used entry now.
    await cache.get('a');
    await cache.set('c', 'C', 60);

    expect((await cache.get('a')).hit).toBe(true);
    expect((await cache.get('b')).hit).toBe(false);
    expect((await cache.get('c')).hit).toBe(true);
  });

  it('treats a write to an existing key as a touch too', async () => {
    const cache = new InMemoryCacheAdapter<string>(2, 'lru');

    await cache.set('a', 'A', 60);
    await cache.set('b', 'B', 60);
    // Re-writing 'a' should count as recent use, same as a read.
    await cache.set('a', 'A2', 60);
    await cache.set('c', 'C', 60);

    expect((await cache.get('a')).hit).toBe(true);
    expect((await cache.get('b')).hit).toBe(false);
  });

  it('enforces the same size limit as fifo', async () => {
    const cache = new InMemoryCacheAdapter<string>(2, 'lru');

    await cache.set('a', 'A', 60);
    await cache.set('b', 'B', 60);
    await cache.set('c', 'C', 60);

    const hits = await Promise.all(['a', 'b', 'c'].map(async (key) => (await cache.get(key)).hit));
    expect(hits.filter(Boolean)).toHaveLength(2);
  });
});

describe('InMemoryCacheAdapter, ttl expiry', () => {
  it('expires identically under fifo and lru, since ttl lives in one shared code path', async () => {
    for (const eviction of ['fifo', 'lru'] as const) {
      const cache = new InMemoryCacheAdapter<string>(10, eviction);
      await cache.set('a', 'A', -1);
      expect((await cache.get('a')).hit).toBe(false);
    }
  });

  it('sweeps already-expired entries out of the store on the next set(), not just on get()', async () => {
    const cache = new InMemoryCacheAdapter<string>(10);

    // Expired immediately, but never read via get(), so it's still sitting
    // in the backing store until the next set() call sweeps it.
    await cache.set('stale', 'A', -1);
    await cache.set('fresh', 'B', 60);

    // Cleanup runs at the top of set(), before the new entry is inserted,
    // so the store should now hold only the fresh entry.
    expect((await cache.get('stale')).hit).toBe(false);
    expect((await cache.get('fresh')).hit).toBe(true);
  });
});
