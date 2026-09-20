import { test as base } from 'vitest';

import { redisCircuitBreaker, type RedisCircuitBreakerAdapter } from '../src/circuitBreaker.js';
import { fromIoredis } from '../src/clients/ioredis.js';
import { redisRateLimit, type RedisRateLimiterAdapter } from '../src/rateLimit.js';
import { connect } from './helpers.js';

import type { Redis } from 'ioredis';

interface RedisFixtures {
  /** This test's own connection, closed once the test is done. */
  redis: Redis;
  /** Opens another connection, for a test that stands in for several processes. Closed once the test is done. */
  newConnection: () => Redis;
  /** Builds a breaker on `redis`, quiet and without a background poll unless told otherwise. Disposed once the test is done. */
  makeBreaker: (options?: Parameters<typeof redisCircuitBreaker>[1]) => RedisCircuitBreakerAdapter;
  /**
   * Builds a limiter, quiet unless told otherwise, on `redis` or on the
   * connection you pass (one per simulated process). Disposed once the test is done.
   */
  makeLimiter: (
    options?: Parameters<typeof redisRateLimit>[1],
    connection?: Redis,
  ) => RedisRateLimiterAdapter;
}

/**
 * `it` for tests that talk to a real Redis.
 *
 * Each test gets its own connection and its own adapters, and cleans them up
 * itself, so tests share nothing and can run at the same time with
 * `it.concurrent` (or inside `describe.concurrent`). Most of these tests
 * spend their time waiting on real cooldowns and leases, which Redis
 * measures on its own clock, so running them together is what keeps a file
 * as fast as its slowest test instead of the sum of all of them.
 *
 * Only tests that leave no trace outside themselves belong in a concurrent
 * block. A test that spies on `Date`, `Math`, `console` or `process` changes
 * things every other test is using, so it stays in an ordinary `describe`.
 */
export const it = base.extend<RedisFixtures>({
  // eslint-disable-next-line no-empty-pattern
  redis: async ({}, use) => {
    const redis = connect();
    await use(redis);
    await redis.quit();
  },

  // eslint-disable-next-line no-empty-pattern
  newConnection: async ({}, use) => {
    const opened: Redis[] = [];
    await use(() => {
      const connection = connect();
      opened.push(connection);
      return connection;
    });
    await Promise.all(opened.map((connection) => connection.quit()));
  },

  makeBreaker: async ({ redis }, use) => {
    const made: RedisCircuitBreakerAdapter[] = [];
    await use((options = {}) => {
      const breaker = redisCircuitBreaker(fromIoredis(redis), {
        pollIntervalMs: 0,
        logger: 'silent',
        ...options,
      });
      made.push(breaker);
      return breaker;
    });
    for (const breaker of made) breaker.dispose();
  },

  makeLimiter: async ({ redis }, use) => {
    const made: RedisRateLimiterAdapter[] = [];
    await use((options = {}, connection = redis) => {
      const limiter = redisRateLimit(fromIoredis(connection), { logger: 'silent', ...options });
      made.push(limiter);
      return limiter;
    });
    for (const limiter of made) limiter.dispose();
  },
});
