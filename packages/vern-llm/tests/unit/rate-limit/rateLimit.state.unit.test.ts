import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../../../src/rateLimit.js';

describe('RateLimiter.getState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports undefined for every field when no buckets are configured', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({});

    expect(limiter.getState()).toEqual({
      requestsRemaining: undefined,
      tokensRemaining: undefined,
      concurrentInFlight: undefined,
    });
  });

  it('reports requestsRemaining and tokensRemaining as full capacity before any acquire', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ requestsPerMinute: 10, tokensPerMinute: 1000 });

    expect(limiter.getState()).toEqual({
      requestsRemaining: 10,
      tokensRemaining: 1000,
      concurrentInFlight: undefined,
    });
  });

  it('decrements requestsRemaining and tokensRemaining after an acquire, before release', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ requestsPerMinute: 10, tokensPerMinute: 1000 });

    // Pinned so the acquire and the getState() check below land at the same
    // instant: real elapsed time here would let the bucket's continuous
    // refill nudge these numbers up, making an exact-equality assertion
    // flaky depending on how long the awaited acquire() actually takes.
    const held = await limiter.acquire(50);

    expect(limiter.getState()).toEqual({
      requestsRemaining: 9,
      tokensRemaining: 950,
      concurrentInFlight: undefined,
    });

    held.release(50);
  });

  it('reports concurrentInFlight as the number of held slots, not free ones', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ maxConcurrent: 3 });

    const first = await limiter.acquire(0);
    const second = await limiter.acquire(0);

    expect(limiter.getState()).toEqual({
      requestsRemaining: undefined,
      tokensRemaining: undefined,
      concurrentInFlight: 2,
    });

    first.release();
    second.release();

    expect(limiter.getState().concurrentInFlight).toBe(0);
  });
});
