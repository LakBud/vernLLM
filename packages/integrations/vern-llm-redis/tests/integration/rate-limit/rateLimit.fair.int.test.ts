import { describe, expect } from 'vitest';

import { fromIoredisSubscriber } from '../../../src/clients/ioredis.js';
import { QUEUE_SCRIPT } from '../../../src/internal/rate-limit/scripts.js';
import { it } from '../../fixtures.js';
import { spyOnScripts, uniquePrefix, waitForRedisValue, waitUntil } from '../../helpers.js';

import type { RedisRateLimitOptions } from '../../../src/rateLimit.js';

/**
 * Each limiter here gets a connection of its own, like a separate process
 * (see `make` in each test), and each test gets its own key prefix, so the
 * tests share nothing and run at the same time.
 */
describe.concurrent('redisRateLimit fair queue across processes, real Redis', () => {
  it('waiters on different processes are served in the order they arrived', async ({
    redis,
    makeLimiter,
    newConnection,
  }) => {
    const make = (options: RedisRateLimitOptions) => makeLimiter(options, newConnection());
    const prefix = uniquePrefix('rl');
    const shared = { keyPrefix: prefix, maxConcurrent: 1, pollIntervalMs: 40, maxQueueMs: 8000 };
    const holder = make(shared);
    const held = await holder.acquire(1);

    const order: string[] = [];
    const releases: Array<() => void> = [];
    const arrive = (name: string) => {
      const limiter = make(shared);
      return limiter.acquire(1).then((got) => {
        order.push(name);
        releases.push(() => got.release());
      });
    };

    const all = [arrive('A')];
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count >= 2,
      {
        timeoutMs: 1000,
        intervalMs: 10,
      },
    );
    all.push(arrive('B'));
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count >= 3,
      {
        timeoutMs: 1000,
        intervalMs: 10,
      },
    );
    all.push(arrive('C'));
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count >= 4,
      {
        timeoutMs: 1000,
        intervalMs: 10,
      },
    );
    all.push(arrive('D'));
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count >= 5,
      {
        timeoutMs: 1000,
        intervalMs: 10,
      },
    );

    held.release();
    for (let i = 0; i < 4; i++) {
      await waitUntil(() => releases.length > i, { timeoutMs: 4000 });
      releases[i]!();
    }
    await Promise.all(all);

    expect(order).toEqual(['A', 'B', 'C', 'D']);
  });

  it('a newcomer cannot barge past a waiter that has not polled yet', async ({
    redis,
    makeLimiter,
    newConnection,
  }) => {
    const make = (options: RedisRateLimitOptions) => makeLimiter(options, newConnection());
    const prefix = uniquePrefix('rl');
    // Poll so slowly that the waiter would not notice a release for ~400ms.
    const shared = { keyPrefix: prefix, maxConcurrent: 1, pollIntervalMs: 400, maxQueueMs: 8000 };
    const holder = make(shared);
    const held = await holder.acquire(1);

    const waiter = make(shared);
    const winner: string[] = [];
    const waiting = waiter.acquire(1).then((got) => {
      winner.push('waiter');
      return got;
    });
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count >= 2,
      { timeoutMs: 2000, intervalMs: 10 },
    );

    held.release();
    await waitForRedisValue(
      () => redis.zcard(`${prefix}:concurrency`),
      (count) => count === 0,
      { timeoutMs: 2000, intervalMs: 10 },
    );

    const newcomer = make({ ...shared, maxQueueMs: 5000 });
    const barged = newcomer.acquire(1).then(
      () => winner.push('newcomer'),
      () => winner.push('newcomer timed out'),
    );

    const got = await waiting;
    got.release();
    await barged;

    expect(winner[0]).toBe('waiter');
  });

  it('with a subscriber the line advances on release, not on the poll interval', async ({
    redis,
    makeLimiter,
    newConnection,
  }) => {
    const make = (options: RedisRateLimitOptions) => makeLimiter(options, newConnection());
    const prefix = uniquePrefix('rl');
    const shared = {
      keyPrefix: prefix,
      maxConcurrent: 1,
      pollIntervalMs: 5000,
      maxQueueMs: 8000,
    };
    const holder = make(shared);
    const held = await holder.acquire(1);

    const waiter = make({
      ...shared,
      subscriber: fromIoredisSubscriber(newConnection()),
    });
    let acquiredAt = 0;
    const waiting = waiter.acquire(1).then(() => (acquiredAt = Date.now()));
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count > 0,
      {
        timeoutMs: 1000,
        intervalMs: 10,
      },
    );

    const releasedAt = Date.now();
    held.release();
    await waiting;

    expect(acquiredAt - releasedAt).toBeLessThan(1500);
  });

  it('a waiter that dies without leaving does not block the line past its lease', async ({
    redis,
    makeLimiter,
    newConnection,
  }) => {
    const make = (options: RedisRateLimitOptions) => makeLimiter(options, newConnection());
    const prefix = uniquePrefix('rl');
    // A ghost took the first ticket and will never come back.
    const queueKey = `${prefix}:queue`;
    const ghostCreatedAt = Date.now();
    await redis.eval(QUEUE_SCRIPT, 1, queueKey, 'enter', 'ghost', 1000, `${prefix}:wake`);
    await waitForRedisValue(
      () => redis.hget(queueKey, 'w:ghost'),
      (value) => value !== null,
      {
        timeoutMs: 1000,
        intervalMs: 10,
      },
    );

    const limiter = make({
      keyPrefix: prefix,
      requestsPerMinute: 60,
      maxConcurrent: 1,
      queueLeaseMs: 1000,
      pollIntervalMs: 50,
      maxQueueMs: 5000,
    });
    // Something is holding the only slot for a moment, so the call must wait its turn.
    const blocker = make({
      keyPrefix: prefix,
      requestsPerMinute: 60,
      maxConcurrent: 1,
      fairQueue: false,
    });
    const held = await blocker.acquire(1);
    const waiting = limiter.acquire(1);
    await waitForRedisValue(
      () => redis.hlen(queueKey),
      (count) => count >= 2,
      { timeoutMs: 2000, intervalMs: 10 },
    );
    held.release();

    const got = await waiting;

    // It waited out the ghost's 1000ms lease rather than being stuck behind it.
    expect(Date.now() - ghostCreatedAt).toBeGreaterThan(900);
    expect(got.waitedMs).toBeLessThan(3000);
  });

  it('an aborted waiter leaves the line, and the queue key goes away when it empties', async ({
    redis,
    makeLimiter,
    newConnection,
  }) => {
    const make = (options: RedisRateLimitOptions) => makeLimiter(options, newConnection());
    const prefix = uniquePrefix('rl');
    const shared = { keyPrefix: prefix, maxConcurrent: 1, pollIntervalMs: 40, maxQueueMs: 8000 };
    const holder = make(shared);
    const held = await holder.acquire(1);

    const controller = new AbortController();
    const waiting = make(shared)
      .acquire(1, controller.signal)
      .catch((e: unknown) => e);
    await waitUntil(async () => (await redis.hlen(`${prefix}:queue`)) > 1);

    controller.abort();
    expect(await waiting).toMatchObject({ type: 'aborted' });
    await waitUntil(async () => (await redis.exists(`${prefix}:queue`)) === 0);

    held.release();
  });

  it('fairQueue false never touches the queue key', async ({
    redis,
    makeLimiter,
    newConnection,
  }) => {
    const make = (options: RedisRateLimitOptions) => makeLimiter(options, newConnection());
    const prefix = uniquePrefix('rl');
    const shared = {
      keyPrefix: prefix,
      maxConcurrent: 1,
      fairQueue: false,
      pollIntervalMs: 40,
      maxQueueMs: 3000,
    };
    const held = await make(shared).acquire(1);
    const connection = newConnection();
    const scripts = spyOnScripts(connection);
    let concurrencyAttempts = 0;
    scripts.mockImplementation(async (command, ...args) => {
      const result = await scripts.real(command, ...args);
      if (args.includes(`${prefix}:concurrency`)) concurrencyAttempts++;
      return result;
    });
    const waiting = makeLimiter(shared, connection).acquire(1);

    try {
      // Observe completed capacity checks, not elapsed time, before checking the empty queue.
      await waitUntil(() => concurrencyAttempts >= 2, { timeoutMs: 2000, intervalMs: 10 });
      expect(await redis.exists(`${prefix}:queue`)).toBe(0);
    } finally {
      held.release();
      scripts.restore();
    }
    (await waiting).release();
  });

  it('a large request at the head is not starved by later small ones', async ({
    redis,
    makeLimiter,
    newConnection,
  }) => {
    const make = (options: RedisRateLimitOptions) => makeLimiter(options, newConnection());
    const prefix = uniquePrefix('rl');
    const shared = {
      keyPrefix: prefix,
      maxConcurrent: 1,
      tokensPerMinute: 60_000, // refills 1000 per second
      pollIntervalMs: 40,
      maxQueueMs: 8000,
    };
    const held = await make(shared).acquire(1);
    // Spend the bucket before queueing requests; concurrency keeps them from taking tokens.
    await make({ keyPrefix: prefix, tokensPerMinute: 60_000 }).acquire(59_999);

    const order: string[] = [];
    const big = make(shared)
      .acquire(300)
      .then((got) => {
        order.push('big');
        got.release();
      });
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count >= 2,
      {
        timeoutMs: 2000,
        intervalMs: 10,
      },
    );
    const smalls = [1, 2, 3].map((n) =>
      make(shared)
        .acquire(10)
        .then((got) => {
          order.push(`small${n}`);
          got.release();
        }),
    );
    await waitForRedisValue(
      () => redis.hlen(`${prefix}:queue`),
      (count) => count >= 5,
      { timeoutMs: 2000, intervalMs: 10 },
    );

    held.release();
    await Promise.all([big, ...smalls]);

    expect(order[0]).toBe('big');
  });
});
