import { describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../../../src/rateLimit.js';

describe('RateLimiter, limit validation', () => {
  const invalidParams = (name: string) =>
    expect.objectContaining({ type: 'invalid_params', message: expect.stringContaining(name) });

  it.each(['requestsPerMinute', 'tokensPerMinute'] as const)(
    'rejects a %s that is negative, NaN, infinite, or between 0 and 1',
    (name) => {
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 1e-320]) {
        expect(() => new RateLimiter({ [name]: value })).toThrow(invalidParams(name));
      }
    },
  );

  it.each(['requestsPerMinute', 'tokensPerMinute'] as const)(
    'accepts a %s of 0 (unlimited), exactly 1, or a fraction above 1',
    (name) => {
      for (const value of [0, 1, 1.5, 500]) {
        expect(() => new RateLimiter({ [name]: value })).not.toThrow();
      }
    },
  );

  it('still treats a requestsPerMinute of 0 as unlimited', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 0 });

    for (let i = 0; i < 100; i++) (await limiter.acquire(0)).release();

    expect(limiter.getState().requestsRemaining).toBeUndefined();
  });

  it('blocks at a requestsPerMinute of exactly 1 and admits the next call once it refills', async () => {
    vi.useFakeTimers();

    try {
      const limiter = new RateLimiter({ requestsPerMinute: 1, maxQueueMs: 0 });

      (await limiter.acquire(0)).release();
      const second = limiter.acquire(0);

      await vi.advanceTimersByTimeAsync(59_999);
      let settled = false;
      void second.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      (await second).release();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['maxConcurrent', 'maxQueueSize'] as const)(
    'rejects a %s that is negative, fractional, NaN, or infinite',
    (name) => {
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new RateLimiter({ [name]: value })).toThrow(invalidParams(name));
      }
    },
  );

  it.each(['maxConcurrent', 'maxQueueSize'] as const)(
    'accepts a %s of 0 (unlimited) or a positive integer',
    (name) => {
      for (const value of [0, 1, 20]) {
        expect(() => new RateLimiter({ [name]: value })).not.toThrow();
      }
    },
  );

  it('rejects a maxQueueMs that is negative, NaN, infinite, or past the longest timer delay', () => {
    for (const maxQueueMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => new RateLimiter({ maxConcurrent: 1, maxQueueMs })).toThrow(
        invalidParams('maxQueueMs'),
      );
    }
  });

  it('accepts a maxQueueMs of 0 (wait indefinitely) up to the longest timer delay', () => {
    for (const maxQueueMs of [0, 1, 2_147_483_647]) {
      expect(() => new RateLimiter({ maxConcurrent: 1, maxQueueMs })).not.toThrow();
    }
  });

  it('keeps a queued call waiting for the full maxQueueMs at the longest timer delay, instead of timing out at once', async () => {
    vi.useFakeTimers();

    try {
      const limiter = new RateLimiter({ maxConcurrent: 1, maxQueueMs: 2_147_483_647 });
      const held = await limiter.acquire(0);
      const queued = limiter.acquire(0);
      let settled = false;
      queued.then(
        () => (settled = true),
        () => (settled = true),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);

      held.release();
      (await queued).release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts every limit left unset', () => {
    expect(() => new RateLimiter({})).not.toThrow();
  });
});
