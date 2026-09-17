import { LLMError, VernLLM } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redisCache } from '../../src/cache.js';
import { redisCircuitBreaker } from '../../src/circuitBreaker.js';
import { fromIoredis } from '../../src/clients/ioredis.js';
import { redisRateLimit } from '../../src/rateLimit.js';
import { connect, createMockClient, uniquePrefix, waitUntil } from '../helpers.js';

import type { Redis } from 'ioredis';
/**
 * Everything else in this suite tests one adapter in isolation, against
 * a fake or a real Redis client directly. This file's job is different:
 * prove the adapters actually work as vern-llm itself uses them, wired
 * into a real VernLLM instance, dispatching real (mocked-provider)
 * calls through vern-llm's own retry/circuit-breaker/rate-limit/cache
 * machinery, not just called directly against a test harness.
 */
describe('VernLLM, wired with real Redis-backed adapters', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = connect();
  });

  afterEach(async () => {
    await redis.quit();
  });

  it('a successful call flows through the circuit breaker, rate limiter, and cache to reach the client', async () => {
    const { client, create } = createMockClient([{ content: 'hello' }]);
    const client_ = fromIoredis(redis);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      // Now that vern-llm's own VernLLMOptions.circuitBreaker type
      // includes CircuitBreakerAdapter, no cast is needed here, this is
      // the actual proof that fix works: a CircuitBreakerAdapter passes
      // straight through without a workaround.
      circuitBreaker: redisCircuitBreaker(client_, {
        keyPrefix: uniquePrefix('cb'),
      }),
      rateLimit: redisRateLimit(client_, { keyPrefix: uniquePrefix('rl') }),
      cache: redisCache(client_, { keyPrefix: uniquePrefix('cache') }),
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('hello');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a real Redis-backed circuit breaker trip blocks the next call before it ever reaches the client', async () => {
    const { client, create } = createMockClient([new Error('down')]);
    const client_ = fromIoredis(redis);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: redisCircuitBreaker(client_, {
        threshold: 1,
        cooldownMs: 10_000,
        keyPrefix: uniquePrefix('cb'),
      }),
    });

    await llm.call({ userContent: 'hi' }).catch(() => {});

    // Wait for the circuit breaker adapter's background confirmation
    // against Redis (see redisCircuitBreaker's own docs) to land.
    await waitUntil(() => llm.getCircuitState() === 'open');

    await expect(llm.call({ userContent: 'hi' })).rejects.toMatchObject({ type: 'circuit_open' });
    // The client was never asked to make that second call, the circuit
    // breaker blocked it before dispatch, not after a failed attempt.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('getCircuitState reads the redis-backed adapter state through the public VernLLM API', async () => {
    const { client } = createMockClient([new Error('down')]);
    const client_ = fromIoredis(redis);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: redisCircuitBreaker(client_, {
        threshold: 1,
        cooldownMs: 10_000,
        keyPrefix: uniquePrefix('cb'),
      }),
    });

    expect(llm.getCircuitState()).toBe('closed');

    await llm.call({ userContent: 'hi' }).catch(() => {});
    await waitUntil(() => llm.getCircuitState() === 'open');

    expect(llm.getCircuitState()).toBe('open');
  });

  it('cachedCall reuses a redis-backed cache hit instead of calling the client again', async () => {
    const { client, create } = createMockClient([{ content: 'first' }, { content: 'second' }]);
    const client_ = fromIoredis(redis);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      cache: redisCache(client_, { keyPrefix: uniquePrefix('cache') }),
    });

    const callParams = { cacheKey: 'k', ttl: 60, call: { userContent: 'hi', jsonMode: false } };

    const first = await llm.cachedCall(callParams);
    const second = await llm.cachedCall(callParams);

    expect(first).toBe('first');
    expect(second).toBe('first'); // served from cache, not the scripted "second"
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a real Redis-backed rate limit block surfaces as a genuine LLMError through call()', async () => {
    const { client, create } = createMockClient([{ content: 'ok' }]);
    const client_ = fromIoredis(redis);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      rateLimit: redisRateLimit(client_, {
        requestsPerMinute: 1,
        maxQueueMs: 300,
        keyPrefix: uniquePrefix('rl'),
      }),
    });

    await llm.call({ userContent: 'hi', jsonMode: false });
    expect(create).toHaveBeenCalledTimes(1);

    const error = await llm.call({ userContent: 'hi', jsonMode: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect((error as InstanceType<typeof LLMError>).type).toBe('rate_limited');
    // The second call never reached the client, it was blocked by the
    // rate limiter before dispatch.
    expect(create).toHaveBeenCalledTimes(1);
  });
});
