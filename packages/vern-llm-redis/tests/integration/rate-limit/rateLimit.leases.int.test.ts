import { describe, expect, vi } from 'vitest';

import { it } from '../../fixtures.js';
import { uniquePrefix, waitUntil } from '../../helpers.js';

describe.concurrent('redisRateLimit leases, real Redis', () => {
  it('a slot whose holder never releases (a crash) frees itself after the lease', async ({
    makeLimiter,
  }) => {
    const prefix = uniquePrefix('rl');
    const crashed = makeLimiter({ keyPrefix: prefix, maxConcurrent: 1, concurrencyLeaseMs: 300 });
    const survivor = makeLimiter({
      keyPrefix: prefix,
      maxConcurrent: 1,
      concurrencyLeaseMs: 300,
      maxQueueMs: 3000,
      pollIntervalMs: 50,
    });

    await crashed.acquire(1);
    // Simulate the crash: renewals stop and release never runs.
    crashed.dispose();

    const acquired = await survivor.acquire(1);
    expect(acquired.waitedMs).toBeGreaterThan(100);
    expect(acquired.reason).toBe('concurrency');
  });

  it('a live call keeps its slot well past one lease, via renewal', async ({ makeLimiter }) => {
    const prefix = uniquePrefix('rl');
    const holder = makeLimiter({ keyPrefix: prefix, maxConcurrent: 1, concurrencyLeaseMs: 1000 });
    const other = makeLimiter({
      keyPrefix: prefix,
      maxConcurrent: 1,
      concurrencyLeaseMs: 1000,
      maxQueueMs: 500,
      pollIntervalMs: 50,
    });

    const held = await holder.acquire(1);
    await new Promise((resolve) => setTimeout(resolve, 2500)); // > 2 leases

    await expect(other.acquire(1)).rejects.toMatchObject({ code: 'rate_limit_queue_timeout' });

    held.release();
    await expect(other.acquire(1)).resolves.toBeDefined();
  });

  it('release frees the slot and stops renewing it', async ({ redis, makeLimiter }) => {
    const prefix = uniquePrefix('rl');
    const limiter = makeLimiter({ keyPrefix: prefix, maxConcurrent: 1, concurrencyLeaseMs: 300 });

    const held = await limiter.acquire(1);
    held.release();

    await waitUntil(async () => (await redis.zcard(`${prefix}:concurrency`)) === 0);
    await new Promise((r) => setTimeout(r, 400));
    expect(await redis.zcard(`${prefix}:concurrency`)).toBe(0);
  });

  it('readState reports live levels from Redis across all three buckets', async ({
    makeLimiter,
  }) => {
    const prefix = uniquePrefix('rl');
    const limiter = makeLimiter({
      keyPrefix: prefix,
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
      maxConcurrent: 3,
    });

    await limiter.acquire(100);
    const state = await limiter.readState();

    expect(state.concurrentInFlight).toBe(1);
    expect(state.requestsRemaining).toBeGreaterThan(8.9);
    expect(state.requestsRemaining).toBeLessThan(9.5);
    expect(state.tokensRemaining).toBeGreaterThan(890);
    expect(state.tokensRemaining).toBeLessThan(910);
  });
});

/**
 * These change something every test shares (the clock, `console`, unhandled
 * rejections), so they run on their own, after the block above has finished.
 */
describe('redisRateLimit with a faked clock or failing Redis', () => {
  it('refill uses the Redis clock, so a client clock far ahead cannot refill or freeze a bucket', async ({
    makeLimiter,
  }) => {
    const prefix = uniquePrefix('rl');
    const limiter = makeLimiter({ keyPrefix: prefix, requestsPerMinute: 2 });

    await limiter.acquire(1);
    await limiter.acquire(1);

    // This process's clock jumps ten minutes ahead. On its own clock the
    // bucket would look fully refilled.
    const realNow = Date.now.bind(Date);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 60_000);

    const blocked = makeLimiter({ keyPrefix: prefix, requestsPerMinute: 2, maxQueueMs: 250 });
    await expect(blocked.acquire(1)).rejects.toMatchObject({ code: 'rate_limit_queue_timeout' });
    now.mockRestore();
  });

  it('a Redis failure during release does not crash the process', async ({
    redis,
    makeLimiter,
  }) => {
    const prefix = uniquePrefix('rl');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evalSpy = vi.spyOn(redis, 'eval');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const limiter = makeLimiter({
      logger: undefined, // this test is about what gets logged
      keyPrefix: prefix,
      maxConcurrent: 1,
      tokensPerMinute: 1000,
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 },
    });
    const held = await limiter.acquire(100);

    evalSpy.mockRejectedValue(new Error('Redis is down'));
    held.release(10, true);
    limiter.signalRateLimit();
    await new Promise((r) => setTimeout(r, 100));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    evalSpy.mockRestore();
  });
});
