import { afterEach, describe, expect, it, vi } from 'vitest';

import { redisRateLimit } from '../../../src/rateLimit.js';
import { fakeRedisClient } from '../../helpers.js';

const take = (avail: number, cap: number) => [1, String(avail), String(cap), '-1'];

describe('redisRateLimit getState (synchronous)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports every configured bucket as untouched before this process has made a call', () => {
    const limiter = redisRateLimit(fakeRedisClient(), {
      fairQueue: false,
      requestsPerMinute: 60,
      tokensPerMinute: 1000,
      maxConcurrent: 4,
    });

    expect(limiter.getState?.()).toEqual({
      requestsRemaining: 60,
      tokensRemaining: 1000,
      concurrentInFlight: 0,
    });
  });

  it('omits buckets that are not configured', () => {
    const limiter = redisRateLimit(fakeRedisClient(), { fairQueue: false, maxConcurrent: 2 });

    expect(limiter.getState?.()).toEqual({ concurrentInFlight: 0 });
  });

  it("reflects the levels Redis reported on this process's last takes", async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const redis = fakeRedisClient();
    redis.eval
      .mockResolvedValueOnce(take(2, 4)) // concurrency: 2 free of 4, so 2 in flight
      .mockResolvedValueOnce(take(41, 60)) // rpm
      .mockResolvedValueOnce(take(900, 1000)); // tpm
    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      requestsPerMinute: 60,
      tokensPerMinute: 1000,
      maxConcurrent: 4,
    });

    await limiter.acquire(100);

    expect(limiter.getState?.()).toEqual({
      requestsRemaining: 41,
      tokensRemaining: 900,
      concurrentInFlight: 2,
    });
  });

  it('refills the per minute buckets forward by the time since that observation', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(take(0, 60)); // rpm empty
    const limiter = redisRateLimit(redis, { fairQueue: false, requestsPerMinute: 60 });
    await limiter.acquire(1);

    now.mockReturnValue(10_000); // 10s at 60/min is 10 requests
    expect(limiter.getState?.().requestsRemaining).toBeCloseTo(10, 5);

    now.mockReturnValue(120_000); // far past full, capped at the ceiling
    expect(limiter.getState?.().requestsRemaining).toBe(60);
  });

  it('gives a concurrency slot back locally the moment it is released, without waiting for Redis', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(take(0, 1)); // the one slot, now taken
    const limiter = redisRateLimit(redis, { fairQueue: false, maxConcurrent: 1 });
    const held = await limiter.acquire(1);
    expect(limiter.getState?.().concurrentInFlight).toBe(1);

    redis.eval.mockReturnValue(new Promise(() => {})); // Redis never answers the release
    held.release();

    expect(limiter.getState?.().concurrentInFlight).toBe(0);
  });

  it('applies a token refund locally too', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(take(500, 1000));
    const limiter = redisRateLimit(redis, { fairQueue: false, tokensPerMinute: 1000 });
    const held = await limiter.acquire(500);

    redis.eval.mockResolvedValue('0');
    held.release(100); // used 100 of the 500 reserved, 400 back

    expect(limiter.getState?.().tokensRemaining).toBe(900);
  });

  it('readState refreshes what getState reports', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(['7', '60']);
    const limiter = redisRateLimit(redis, { fairQueue: false, requestsPerMinute: 60 });

    await limiter.readState();

    expect(limiter.getState?.().requestsRemaining).toBe(7);
  });

  it('readState reports how many slots are in flight for a concurrency bucket', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(['1', '3']);
    const limiter = redisRateLimit(redis, { fairQueue: false, maxConcurrent: 3 });

    const state = await limiter.readState();

    expect(state.concurrentInFlight).toBe(2);
  });

  it('readState reports tokens remaining for a tokensPerMinute bucket', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(['400', '1000']);
    const limiter = redisRateLimit(redis, { fairQueue: false, tokensPerMinute: 1000 });

    const state = await limiter.readState();

    expect(state.tokensRemaining).toBe(400);
  });
});
