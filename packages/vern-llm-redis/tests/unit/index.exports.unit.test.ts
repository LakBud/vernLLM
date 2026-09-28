import { describe, expect, it } from 'vitest';

import * as clientsEntry from '../../src/clients/index.js';
import * as entry from '../../src/index.js';
import {
  redisCache,
  redisCircuitBreaker,
  redisRateLimit,
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
      'redisCache',
      'redisCircuitBreaker',
      'redisRateLimit',
    ]);
  });

  it('exports the factory functions and adapter types', () => {
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

describe('clients subpath exports', () => {
  it('exports exactly both client adapters', () => {
    expect(Object.keys(clientsEntry).sort()).toEqual([
      'fromIoredis',
      'fromIoredisSubscriber',
      'fromNodeRedis',
      'fromNodeRedisSubscriber',
    ]);
  });

  it('is the only entry that exports the client adapters', () => {
    expect(entry).not.toHaveProperty('fromIoredis');
    expect(entry).not.toHaveProperty('fromNodeRedis');
  });

  it('exports the client types', () => {
    const client: clientsEntry.RedisClient = {
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      eval: async () => undefined,
    };
    const subscriber: clientsEntry.RedisSubscriber = {
      subscribe: async () => undefined,
      on: () => undefined,
    };
    const node: clientsEntry.NodeRedisLike = {
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      eval: async () => undefined,
    };
    const nodeSubscriber: clientsEntry.NodeRedisSubscriberLike = {
      subscribe: async () => undefined,
    };
    const io: clientsEntry.IoredisLike = client;
    const ioSubscriber: clientsEntry.IoredisSubscriberLike = subscriber;

    expect([client, subscriber, node, nodeSubscriber, io, ioSubscriber]).toHaveLength(6);
  });
});
