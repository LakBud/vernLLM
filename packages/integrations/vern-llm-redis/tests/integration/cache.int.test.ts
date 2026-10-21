import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redisCache } from '../../src/cache.js';
import { fromIoredis } from '../../src/clients/ioredis.js';
import { connect, uniquePrefix } from '../helpers.js';

import type { Redis } from 'ioredis';

describe('redisCache, real Redis', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = connect();
  });

  afterEach(async () => {
    await redis.quit();
  });

  it('stores and retrieves a value round trip', async () => {
    const cache = redisCache(fromIoredis(redis), { keyPrefix: uniquePrefix('cache') });

    await cache.set('k', { hello: 'world' }, 60);
    await expect(cache.get('k')).resolves.toEqual({ hit: true, value: { hello: 'world' } });
  });

  it('reports a miss for a key that was never set', async () => {
    const cache = redisCache(fromIoredis(redis), { keyPrefix: uniquePrefix('cache') });
    await expect(cache.get('never-set')).resolves.toEqual({ hit: false, value: null });
  });

  it('expires a value after its TTL elapses', async () => {
    const cache = redisCache(fromIoredis(redis), { keyPrefix: uniquePrefix('cache') });

    // A fraction of a second is enough: the TTL is in seconds and rounds up to whole milliseconds.
    await cache.set('k', 'v', 0.3);
    await expect(cache.get('k')).resolves.toEqual({ hit: true, value: 'v' });

    await new Promise((resolve) => setTimeout(resolve, 450));
    await expect(cache.get('k')).resolves.toEqual({ hit: false, value: null });
  });

  it('deletes a value immediately, before its TTL would otherwise expire it', async () => {
    const cache = redisCache(fromIoredis(redis), { keyPrefix: uniquePrefix('cache') });

    await cache.set('k', 'v', 60);
    await cache.delete?.('k');

    await expect(cache.get('k')).resolves.toEqual({ hit: false, value: null });
  });

  it('keeps two different prefixes fully isolated from each other', async () => {
    const prefix = uniquePrefix('cache');
    const cacheA = redisCache(fromIoredis(redis), { keyPrefix: `${prefix}:a` });
    const cacheB = redisCache(fromIoredis(redis), { keyPrefix: `${prefix}:b` });

    await cacheA.set('k', 'from-a', 60);
    await expect(cacheB.get('k')).resolves.toEqual({ hit: false, value: null });
  });
});

describe('redisCache TTL edge cases, real Redis', () => {
  it.each([0, -1, 0.0005, Infinity])('ttl %s never makes Redis reject the write', async (ttl) => {
    const redis = connect();
    const cache = redisCache<{ a: number }>(fromIoredis(redis), { keyPrefix: uniquePrefix('c') });

    await expect(cache.set('k', { a: 1 }, ttl)).resolves.toBeUndefined();
    await redis.quit();
  });
});
