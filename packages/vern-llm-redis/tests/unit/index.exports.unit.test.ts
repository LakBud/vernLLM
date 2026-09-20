import { describe, expect, it } from 'vitest';

import * as entry from '../../src/index.js';
import {
  fromIoredis,
  fromIoredisSubscriber,
  fromNodeRedis,
  fromNodeRedisSubscriber,
  redisCache,
  redisCircuitBreaker,
  redisRateLimit,
  type IoredisLike,
  type IoredisSubscriberLike,
  type NodeRedisLike,
  type NodeRedisSubscriberLike,
  type RedisCacheOptions,
  type RedisCircuitBreakerAdapter,
  type RedisCircuitBreakerOptions,
  type RedisClient,
  type RedisCooldownBackoff,
  type RedisRateLimitOptions,
  type RedisRateLimiterAdapter,
  type RedisSubscriber,
  type RedisTrippingOption,
} from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'fromIoredis',
      'fromIoredisSubscriber',
      'fromNodeRedis',
      'fromNodeRedisSubscriber',
      'redisCache',
      'redisCircuitBreaker',
      'redisRateLimit',
    ]);
  });

  it('exports the factory functions and adapter types', () => {
    expect(typeof fromIoredis).toBe('function');
    expect(typeof fromIoredisSubscriber).toBe('function');
    expect(typeof fromNodeRedis).toBe('function');
    expect(typeof fromNodeRedisSubscriber).toBe('function');
    expect(typeof redisCache).toBe('function');
    expect(typeof redisCircuitBreaker).toBe('function');
    expect(typeof redisRateLimit).toBe('function');

    const cacheOptions: RedisCacheOptions = { keyPrefix: 'app' };
    const client: RedisClient = {
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      eval: async () => undefined,
    };
    const subscriber: RedisSubscriber = {
      subscribe: async () => undefined,
      on: () => undefined,
    };

    expect(redisCache(client, cacheOptions)).toBeDefined();
    expect(subscriber.on).toBeDefined();

    const ioredisClient: IoredisLike = {
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      eval: async () => undefined,
    };
    const ioredisSubscriber: IoredisSubscriberLike = {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      on: () => undefined,
    };
    const nodeRedisClient: NodeRedisLike = {
      get: async () => null,
      set: async (_key, _value, _options) => undefined,
      del: async () => undefined,
      eval: async () => undefined,
    };
    const nodeRedisSubscriber: NodeRedisSubscriberLike = {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    };

    expect(ioredisClient).toBeDefined();
    expect(ioredisSubscriber).toBeDefined();
    expect(nodeRedisClient).toBeDefined();
    expect(nodeRedisSubscriber).toBeDefined();
  });

  it('exports the public types used in the Redis adapter API', () => {
    const assertCacheOptions = (_opts: RedisCacheOptions) => _opts;
    const assertBreakerOptions = (_opts: RedisCircuitBreakerOptions) => _opts;
    const assertBreakerAdapter = (_adapter: RedisCircuitBreakerAdapter) => _adapter;
    const assertCooldownBackoff = (_value: RedisCooldownBackoff) => _value;
    const assertRateLimitOptions = (_opts: RedisRateLimitOptions) => _opts;
    const assertRateLimiterAdapter = (_adapter: RedisRateLimiterAdapter) => _adapter;
    const assertTrippingOption = (_value: RedisTrippingOption) => _value;

    expect(assertCacheOptions).toBeDefined();
    expect(assertBreakerOptions).toBeDefined();
    expect(assertBreakerAdapter).toBeDefined();
    expect(assertCooldownBackoff).toBeDefined();
    expect(assertRateLimitOptions).toBeDefined();
    expect(assertRateLimiterAdapter).toBeDefined();
    expect(assertTrippingOption).toBeDefined();
  });
});
