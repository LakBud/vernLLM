import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redisCache } from '../../src/cache.js';
import { redisCircuitBreaker } from '../../src/circuitBreaker.js';
import { fromNodeRedis, fromNodeRedisSubscriber } from '../../src/clients/nodeRedis.js';
import { redisRateLimit } from '../../src/rateLimit.js';
import { connectNodeRedis, expectNearInstant, uniquePrefix, waitUntil } from '../helpers.js';

import type { RedisClientType } from 'redis';

/**
 * The core adapter logic (circuitBreaker.int.test.ts, rateLimit.int.test.ts,
 * cache.int.test.ts) is already exercised end to end against ioredis. This
 * file's job is narrower and specific to node-redis: prove fromNodeRedis
 * and fromNodeRedisSubscriber translate correctly against a real server,
 * not just against the mocked client in clients/nodeRedis.unit.test.ts.
 */
describe('fromNodeRedis, real Redis', () => {
  let client: RedisClientType;

  beforeEach(async () => {
    client = await connectNodeRedis();
  });

  afterEach(async () => {
    await client.quit();
  });

  it('redisCache stores and retrieves a value round trip through the translated set/get calls', async () => {
    const cache = redisCache(fromNodeRedis(client), { keyPrefix: uniquePrefix('cache') });

    await cache.set('k', { hello: 'world' }, 60);
    await expect(cache.get('k')).resolves.toEqual({ hit: true, value: { hello: 'world' } });
  });

  it('redisCache deletes through the translated del call', async () => {
    const cache = redisCache(fromNodeRedis(client), { keyPrefix: uniquePrefix('cache') });

    await cache.set('k', 'v', 60);
    await cache.delete?.('k');

    await expect(cache.get('k')).resolves.toEqual({ hit: false, value: null });
  });

  it('redisCircuitBreaker opens after threshold failures through the translated eval calls', async () => {
    const breaker = redisCircuitBreaker(fromNodeRedis(client), {
      threshold: 2,
      cooldownMs: 500,
      keyPrefix: uniquePrefix('cb'),
    });

    expect(() => breaker.assertClosed('m')).not.toThrow();
    breaker.recordFailure('m');
    breaker.recordFailure('m');

    await waitUntil(() => {
      try {
        breaker.assertClosed('m');
        return false;
      } catch {
        return true;
      }
    });

    expect(() => breaker.assertClosed('m')).toThrow();
  });

  it('redisRateLimit enforces a requests-per-minute ceiling through the translated eval calls', async () => {
    const limiter = redisRateLimit(fromNodeRedis(client), {
      requestsPerMinute: 2,
      keyPrefix: uniquePrefix('rl'),
    });

    const first = await limiter.acquire(1);
    const second = await limiter.acquire(1);
    expectNearInstant(first.waitedMs);
    expectNearInstant(second.waitedMs);

    const controller = new AbortController();
    let settled = false;
    const thirdPromise = limiter
      .acquire(1, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    controller.abort();
    await thirdPromise;
  });
});

describe('fromNodeRedisSubscriber, real Redis', () => {
  let publisherClient: RedisClientType;
  let subscriberClient: RedisClientType;

  beforeEach(async () => {
    publisherClient = await connectNodeRedis();
    subscriberClient = publisherClient.duplicate() as RedisClientType;
    await subscriberClient.connect();
  });

  afterEach(async () => {
    await subscriberClient.quit();
    await publisherClient.quit();
  });

  it('a circuit breaker transition propagates through a real node-redis pub/sub connection', async () => {
    const keyPrefix = uniquePrefix('cb');

    // A second, independent publisher connection, standing in for a
    // second process sharing the same Redis key.
    const otherPublisher = await connectNodeRedis();

    try {
      const breakerA = redisCircuitBreaker(fromNodeRedis(otherPublisher), {
        threshold: 1,
        cooldownMs: 10_000,
        keyPrefix,
      });

      const events: Array<{ from: string; to: string }> = [];
      const breakerB = redisCircuitBreaker(fromNodeRedis(publisherClient), {
        threshold: 1,
        cooldownMs: 10_000,
        keyPrefix,
        subscriber: fromNodeRedisSubscriber(subscriberClient),
        onStateChange: (from, to) => events.push({ from, to }),
      });

      // Give the SUBSCRIBE command time to actually register before the
      // transition fires, matching the same reasoning as the ioredis
      // pub/sub integration test.
      await new Promise((resolve) => setTimeout(resolve, 200));

      breakerA.recordFailure('m');
      await waitUntil(() => events.length > 0);

      expect(() => breakerB.assertClosed('m')).toThrow();
      expect(events).toContainEqual({ from: 'closed', to: 'open' });
    } finally {
      await otherPublisher.quit();
    }
  });
});
