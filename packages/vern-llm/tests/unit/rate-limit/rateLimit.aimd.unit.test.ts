import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../../../src/rateLimit.js';

describe('RateLimiter, AIMD', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Whether `promise` is still pending after flushing several microtask
   * ticks, used to probe a limiter's exact current capacity without
   * relying on `maxQueueSize` rejection (sequential, one-at-a-time
   * `await acquire()` calls never actually pile up in the queue, since
   * each resolves before the next is issued) or on real wall-clock
   * waiting for refill. `promise` is deliberately never awaited when
   * pending, only settled ones report `false`; an unresolved one is left
   * dangling for the caller to resolve later (e.g. by releasing a held
   * slot or advancing fake timers).
   */
  async function isPending(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return !settled;
  }

  it('grows the requests bucket ceiling by increaseBy on every clean release, confirmed via a full-window refill', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 2,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
    });

    // Drain the starting capacity of 2, then release both as confirmed
    // successes, each release growing the ceiling by 1: 2 -> 3 -> 4.
    const first = await limiter.acquire(0);
    const second = await limiter.acquire(0);
    first.release(undefined, true);
    second.release(undefined, true);

    // Advance a full minute so the (now higher) ceiling is fully
    // refilled, isolating "did the ceiling grow" from "has it refilled
    // yet", which are two different questions.
    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 4; i++) {
      held.push(await limiter.acquire(0));
    }

    const fifth = limiter.acquire(0);
    expect(await isPending(fifth)).toBe(true);

    for (const h of held) h.release();
  });

  it('growth is capped at maxCapacity, never exceeding it', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 2,
      aimd: { increaseBy: 5, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 3 },
    });

    // Two confirmed-success releases would push the ceiling to
    // 2 + 5 + 5 = 12 uncapped; maxCapacity clamps it to 3.
    const first = await limiter.acquire(0);
    const second = await limiter.acquire(0);
    first.release(undefined, true);
    second.release(undefined, true);

    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 3; i++) {
      held.push(await limiter.acquire(0));
    }

    const fourth = limiter.acquire(0);
    expect(await isPending(fourth)).toBe(true);

    for (const h of held) h.release();
  });

  it('signalRateLimit shrinks the ceiling by decreaseFactor, confirmed via a full-window refill', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 10,
      aimd: { increaseBy: 0, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
    });

    limiter.signalRateLimit(); // ceiling: 10 -> 5

    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 5; i++) {
      held.push(await limiter.acquire(0));
    }

    const sixth = limiter.acquire(0);
    expect(await isPending(sixth)).toBe(true);

    for (const h of held) h.release();
  });

  it('signalRateLimit never shrinks below minCapacity, even called repeatedly', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 10,
      aimd: { increaseBy: 0, decreaseFactor: 0.5, minCapacity: 2, maxCapacity: 100 },
    });

    // One shrink per window, so each signal lands in its own window:
    // 10 -> 5 -> 2.5 -> 2 (floored), and would go toward 0 uncapped.
    for (let i = 0; i < 10; i++) {
      limiter.signalRateLimit();
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const held = [];
    for (let i = 0; i < 2; i++) {
      held.push(await limiter.acquire(0));
    }

    const third = limiter.acquire(0);
    expect(await isPending(third)).toBe(true);

    for (const h of held) h.release();
  });

  /** How many acquires succeed right now before one would block. */
  async function capacityNow(limiter: RateLimiter): Promise<number> {
    const held = [];
    for (;;) {
      const next = limiter.acquire(0);
      if (await isPending(next)) {
        for (const h of held) h.release();
        return held.length;
      }
      held.push(await next);
    }
  }

  it('shrinks only once for a burst of rate limit signals in the same window', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 16,
      maxQueueMs: 0,
      aimd: { increaseBy: 0, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
    });

    // Five concurrent 429s describe the same overload.
    for (let i = 0; i < 5; i++) limiter.signalRateLimit();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await capacityNow(limiter)).toBe(8);
  });

  it('counts a proactive hint shrink toward the same window as a 429', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 16,
      maxQueueMs: 0,
      aimd: {
        increaseBy: 0,
        decreaseFactor: 0.5,
        minCapacity: 1,
        maxCapacity: 100,
        proactiveFloor: 5,
      },
    });

    limiter.reactToRateLimitHint({ remainingRequests: 2 });
    limiter.signalRateLimit();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await capacityNow(limiter)).toBe(8);
  });

  it('shrinks again once a full window has passed since the last shrink', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 16,
      maxQueueMs: 0,
      aimd: { increaseBy: 0, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
    });

    limiter.signalRateLimit(); // 16 -> 8
    await vi.advanceTimersByTimeAsync(59_999);
    limiter.signalRateLimit(); // same window, ignored
    await vi.advanceTimersByTimeAsync(1);
    limiter.signalRateLimit(); // new window, 8 -> 4

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await capacityNow(limiter)).toBe(4);
  });

  it('treats a clock that moved backwards as a new window instead of blocking shrinks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

    const limiter = new RateLimiter({
      requestsPerMinute: 16,
      maxQueueMs: 0,
      aimd: { increaseBy: 0, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
    });

    limiter.signalRateLimit(); // 16 -> 8
    vi.setSystemTime(new Date('2026-01-01T11:00:00Z'));
    limiter.signalRateLimit(); // clock went back an hour, 8 -> 4

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await capacityNow(limiter)).toBe(4);
  });

  it('signalRateLimit and growOnSuccess are no-ops without aimd configured', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({ requestsPerMinute: 3 });

    limiter.signalRateLimit(); // no aimd: must not throw or change anything

    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 3; i++) {
      held.push(await limiter.acquire(0));
    }

    // Ceiling unchanged at 3: a 4th still blocks.
    const fourth = limiter.acquire(0);
    expect(await isPending(fourth)).toBe(true);

    for (const h of held) h.release();
  });

  it('reactToRateLimitHint shrinks the ceiling when remainingRequests is at or below proactiveFloor', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 10,
      aimd: {
        increaseBy: 0,
        decreaseFactor: 0.5,
        minCapacity: 1,
        maxCapacity: 100,
        proactiveFloor: 5,
      },
    });

    limiter.reactToRateLimitHint({ remainingRequests: 5 }); // at the floor: shrinks 10 -> 5
    limiter.reactToRateLimitHint({ remainingRequests: 50 }); // well above floor: no-op

    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 5; i++) {
      held.push(await limiter.acquire(0));
    }

    const sixth = limiter.acquire(0);
    expect(await isPending(sixth)).toBe(true);

    for (const h of held) h.release();
  });

  it('reactToRateLimitHint is a no-op when proactiveFloor is left at its default (0, meaning off)', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 3,
      aimd: { increaseBy: 0, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
    });

    limiter.reactToRateLimitHint({ remainingRequests: 0 }); // would trip any nonzero floor

    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 3; i++) {
      held.push(await limiter.acquire(0));
    }

    const fourth = limiter.acquire(0);
    expect(await isPending(fourth)).toBe(true);

    for (const h of held) h.release();
  });

  it('reactToRateLimitHint is a no-op when the hint has no remainingRequests', () => {
    const limiter = new RateLimiter({
      requestsPerMinute: 100,
      aimd: {
        increaseBy: 0,
        decreaseFactor: 0.5,
        minCapacity: 10,
        maxCapacity: 1000,
        proactiveFloor: 100,
      },
    });

    expect(() => limiter.reactToRateLimitHint({})).not.toThrow();
    expect(() => limiter.reactToRateLimitHint(undefined)).not.toThrow();
  });

  it('throws at construction when aimd.minCapacity exceeds aimd.maxCapacity', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 200, maxCapacity: 100 },
        }),
    ).toThrow(/minCapacity/);
  });

  it('throws at construction when aimd.maxCapacity is 0', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 0, maxCapacity: 0 },
        }),
    ).toThrow(/maxCapacity/);
  });

  it('throws at construction when aimd.minCapacity is negative', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: -1, maxCapacity: 100 },
        }),
    ).toThrow(/minCapacity/);
  });

  it('throws at construction when aimd.minCapacity or aimd.maxCapacity is a fraction below 1, since the requests bucket always takes 1 and could never be satisfied', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 0.5, maxCapacity: 100 },
        }),
    ).toThrow(/minCapacity/);

    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 0.5, maxCapacity: 0.9 },
        }),
    ).toThrow(/maxCapacity/);
  });

  it('accepts a fractional aimd.maxCapacity/minCapacity at or above 1', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 2.5 },
        }),
    ).not.toThrow();
  });

  it('signalRateLimit shrinking toward a fractional-but->=1 minCapacity still leaves acquisition possible', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 10,
      aimd: { increaseBy: 0, decreaseFactor: 0.1, minCapacity: 1.5, maxCapacity: 100 },
    });

    // Repeated shrinks would drive capacity toward 0 uncapped;
    // minCapacity floors it at 1.5, still >= 1, so a request can still
    // eventually be satisfied once refilled.
    for (let i = 0; i < 20; i++) limiter.signalRateLimit();

    await vi.advanceTimersByTimeAsync(60_000);

    const held = await limiter.acquire(0);
    expect(held).toBeDefined();
    held.release();
  });

  it('throws at construction when aimd.minCapacity or aimd.maxCapacity is NaN', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: NaN, maxCapacity: 100 },
        }),
    ).toThrow(/finite/);

    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: NaN },
        }),
    ).toThrow(/finite/);
  });

  it('throws at construction when aimd.minCapacity or aimd.maxCapacity is infinite', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: Infinity },
        }),
    ).toThrow(/finite/);

    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: -Infinity, maxCapacity: 100 },
        }),
    ).toThrow(/finite/);
  });

  it('throws at construction when aimd.increaseBy is NaN', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: NaN, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
        }),
    ).toThrow(/finite/);
  });

  it('throws at construction when aimd.decreaseFactor is NaN', () => {
    expect(
      () =>
        new RateLimiter({
          requestsPerMinute: 100,
          aimd: { increaseBy: 1, decreaseFactor: NaN, minCapacity: 1, maxCapacity: 100 },
        }),
    ).toThrow(/finite/);
  });

  it('clamps a decreaseFactor outside (0, 1] instead of doubling capacity', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 3,
      aimd: { increaseBy: 0, decreaseFactor: 2, minCapacity: 1, maxCapacity: 100 },
    });

    limiter.signalRateLimit(); // decreaseFactor clamped to 1: ceiling unchanged at 3, not 6

    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 3; i++) {
      held.push(await limiter.acquire(0));
    }

    const fourth = limiter.acquire(0);
    expect(await isPending(fourth)).toBe(true);

    for (const h of held) h.release();
  });

  it('a failed or rate-limited release (no success flag) does not grow the AIMD ceiling', async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({
      requestsPerMinute: 2,
      aimd: { increaseBy: 5, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 },
    });

    // A real 429 shrinks the ceiling 2 -> 1.
    limiter.signalRateLimit();

    // The failed attempt still releases its slot, exactly like a
    // successful one must, but without confirming success. If this call
    // grows the ceiling back up, it would partially cancel the shrink
    // above.
    const first = await limiter.acquire(0);
    first.release();

    await vi.advanceTimersByTimeAsync(60_000);

    // Ceiling should still be exactly 1: only a second, real success
    // could grow it.
    const held = [await limiter.acquire(0)];
    const second = limiter.acquire(0);
    expect(await isPending(second)).toBe(true);

    for (const h of held) h.release();
  });

  it('throws at construction when aimd is set without requestsPerMinute, since there is no ceiling to adjust', () => {
    const aimd = { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 };

    for (const requestsPerMinute of [undefined, 0]) {
      expect(() => new RateLimiter({ requestsPerMinute, tokensPerMinute: 100, aimd })).toThrow(
        expect.objectContaining({
          type: 'invalid_params',
          message: expect.stringMatching(/aimd requires requestsPerMinute/),
        }),
      );
    }
  });

  it('throws at construction when aimd.proactiveFloor is negative, NaN or infinite', () => {
    for (const proactiveFloor of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new RateLimiter({
            requestsPerMinute: 10,
            aimd: {
              increaseBy: 1,
              decreaseFactor: 0.5,
              minCapacity: 1,
              maxCapacity: 10,
              proactiveFloor,
            },
          }),
      ).toThrow(
        expect.objectContaining({
          type: 'invalid_params',
          message: expect.stringMatching(/proactiveFloor/),
        }),
      );
    }
  });
});
