import { describe, expect, it } from 'vitest';

import { redisCache } from '../../src/cache.js';
import { fakeRedisClient } from '../helpers.js';

describe('redisCache', () => {
  it('reports a miss when the key is absent', async () => {
    const redis = fakeRedisClient();
    redis.get.mockResolvedValue(null);

    const cache = redisCache(redis);
    await expect(cache.get('k')).resolves.toEqual({ hit: false, value: null });
  });

  it('reports a hit and parses the stored JSON value', async () => {
    const redis = fakeRedisClient();
    redis.get.mockResolvedValue(JSON.stringify({ answer: 42 }));

    const cache = redisCache(redis);
    await expect(cache.get('k')).resolves.toEqual({ hit: true, value: { answer: 42 } });
  });

  it('treats a corrupted stored value as a miss instead of throwing', async () => {
    const redis = fakeRedisClient();
    redis.get.mockResolvedValue('not json{{{');

    const cache = redisCache(redis);
    await expect(cache.get('k')).resolves.toEqual({ hit: false, value: null });
  });

  it('prefixes keys with the default prefix', async () => {
    const redis = fakeRedisClient();
    redis.get.mockResolvedValue(null);

    const cache = redisCache(redis);
    await cache.get('mykey');

    expect(redis.get).toHaveBeenCalledWith('vernllm:cache:mykey');
  });

  it('prefixes keys with a custom prefix when supplied', async () => {
    const redis = fakeRedisClient();
    redis.get.mockResolvedValue(null);

    const cache = redisCache(redis, { keyPrefix: 'myapp:cache' });
    await cache.get('mykey');

    expect(redis.get).toHaveBeenCalledWith('myapp:cache:mykey');
  });

  it('serializes the value and sets it with a millisecond TTL derived from the seconds ttl', async () => {
    const redis = fakeRedisClient();

    const cache = redisCache(redis);
    await cache.set('k', { a: 1 }, 60);

    expect(redis.set).toHaveBeenCalledWith(
      'vernllm:cache:k',
      JSON.stringify({ a: 1 }),
      'PX',
      60_000,
    );
  });

  it('deletes the prefixed key', async () => {
    const redis = fakeRedisClient();

    const cache = redisCache(redis);
    await cache.delete?.('k');

    expect(redis.del).toHaveBeenCalledWith('vernllm:cache:k');
  });
});
