import { describe, it, expect, vi, afterEach } from 'vitest';

import { defaultEstimateTokens, RateLimiter, type WireRequest } from '../../src/rateLimit.js';

function request(overrides: Partial<WireRequest> = {}): WireRequest {
  return {
    model: 'test-model',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('defaultEstimateTokens', () => {
  it('estimates chars/4 over message content plus max_tokens', () => {
    // 'hello' is 5 chars -> ceil(5/4) = 2, plus max_tokens 100
    expect(defaultEstimateTokens(request())).toBe(102);
  });

  it('stringifies non-string content blocks instead of throwing', () => {
    const req = request({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] as never }],
    });
    expect(() => defaultEstimateTokens(req)).not.toThrow();
    expect(defaultEstimateTokens(req)).toBeGreaterThan(100);
  });
});

describe('RateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires immediately with waitedMs 0 when under every limit', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 10, maxConcurrent: 5 });
    const result = await limiter.acquire(10);
    expect(result.waitedMs).toBe(0);
    result.release();
  });

  it('maxConcurrent blocks a second call until the first releases', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, maxQueueMs: 0 });

    const first = await limiter.acquire(1);

    let secondSettled = false;
    const secondPromise = limiter.acquire(1).then((r) => {
      secondSettled = true;
      return r;
    });

    // Give the microtask queue a chance to run; the second acquire should
    // still be pending since the only slot is held by `first`.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    first.release();

    const second = await secondPromise;
    expect(secondSettled).toBe(true);
    expect(second.waitedMs).toBeGreaterThanOrEqual(0);
    second.release();
  });

  it('requestsPerMinute admits up to capacity then blocks, and refills over time', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ requestsPerMinute: 60, maxQueueMs: 0 });

    // 60 requests/min = 1 request/sec worth of refill; capacity starts full at 60.
    for (let i = 0; i < 60; i++) {
      const r = await limiter.acquire(1);
      expect(r.waitedMs).toBe(0);
    }

    // Bucket is now empty; queueing is disabled (maxQueueMs: 0 means
    // "wait indefinitely" per the option's contract, not "reject", so
    // instead we assert the call does NOT resolve yet).
    let resolved = false;
    const pending = limiter.acquire(1).then((r) => {
      resolved = true;
      return r;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance past the refill window for one token (60/min => 1 per 1000ms).
    await vi.advanceTimersByTimeAsync(1100);

    const result = await pending;
    expect(resolved).toBe(true);
    expect(result.waitedMs).toBeGreaterThan(0);
    result.release();
  });

  it('tokensPerMinute blocks on the pre-flight estimate and reconciles on release', async () => {
    const limiter = new RateLimiter({ tokensPerMinute: 100, maxQueueMs: 0 });

    const first = await limiter.acquire(80);
    expect(first.waitedMs).toBe(0);

    // Only 20 tokens left; a 30-token request should block.
    let secondSettled = false;
    const secondPromise = limiter.acquire(30).then(() => {
      secondSettled = true;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false);

    // Release the first, reporting actual usage of only 10 tokens (lower
    // than the 80 estimated), freeing capacity beyond what a naive full
    // refund would.
    first.release(10);

    await secondPromise;
    expect(secondSettled).toBe(true);
  });

  it('maxQueueMs throws a rate_limit_queue_timeout-coded rate_limited error', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ maxConcurrent: 1, maxQueueMs: 1000 });

    const held = await limiter.acquire(1);

    const pending = limiter.acquire(1);
    const assertion = expect(pending).rejects.toMatchObject({
      type: 'rate_limited',
      code: 'rate_limit_queue_timeout',
    });

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    held.release();
  });

  it('does not lose refilled capacity when the system clock jumps backward mid-window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const limiter = new RateLimiter({ requestsPerMinute: 60, maxQueueMs: 0 });

    // Drain the bucket to empty (60/min capacity, starts full). Each of
    // these calls refill() at t=0, so `lastRefill` ends at 0.
    for (let i = 0; i < 60; i++) {
      const r = await limiter.acquire(1);
      r.release();
    }

    // t=300: this acquire call synchronously calls refill() (60/min =>
    // 1/1000ms, so 300ms => 0.3 tokens refilled, still short of the 1
    // needed) before queueing. `lastRefill` is now pinned at 300.
    vi.setSystemTime(300);
    const first = limiter.acquire(1);

    // Clock jumps backward to before the last refill (NTP correction, VM
    // migration, etc.). This second acquire enqueues behind the first and
    // triggers `drain()`, which re-checks the head waiter and so calls
    // refill() again, this time with a negative elapsed time relative to
    // the `lastRefill` pinned above.
    vi.setSystemTime(0);
    void limiter.acquire(1).catch(() => {});

    // Without the fix, the negative elapsed time gets multiplied into
    // `available`, erasing the 0.3 tokens already refilled (0.3 + (-300 *
    // 1/1000) = 0), so reaching 1 full token needs another 1000ms from
    // here. With the fix, `available` is untouched by the backward jump
    // (stays 0.3), so only ~700ms more is needed. Advancing to 850ms
    // distinguishes the two: the fixed bucket has already woken by then,
    // the buggy one has not.
    let resolved = false;
    void first.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(850);

    expect(resolved).toBe(true);
  });

  it('maxQueueSize rejects immediately once the queue is already full', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, maxQueueSize: 1, maxQueueMs: 0 });

    const held = await limiter.acquire(1);
    const queued = limiter.acquire(1); // fills the one queue slot

    await expect(limiter.acquire(1)).rejects.toMatchObject({
      type: 'rate_limited',
      code: 'rate_limit_queue_full',
    });

    held.release();
    (await queued).release();
  });

  it('a queued waiter that aborts rejects with "aborted" and frees the queue slot', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, maxQueueMs: 0 });
    const controller = new AbortController();

    const held = await limiter.acquire(1);

    const pending = limiter.acquire(1, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ type: 'aborted' });

    controller.abort();
    await assertion;

    // The queue slot from the aborted waiter should be gone, so a fresh
    // acquire (still contending for the single concurrency slot) queues
    // cleanly instead of being blocked by a stale, already-rejected entry.
    held.release();
    const after = await limiter.acquire(1);
    expect(after.waitedMs).toBeGreaterThanOrEqual(0);
    after.release();
  });

  it('is FIFO: an earlier, larger waiter is not starved by a later, smaller one', async () => {
    vi.useFakeTimers();
    // 600 tokens/min => 10 tokens/sec refill.
    const limiter = new RateLimiter({ tokensPerMinute: 600, maxQueueMs: 0 });

    const held = await limiter.acquire(600); // drains the bucket completely
    expect(held.waitedMs).toBe(0);

    const order: string[] = [];
    const big = limiter.acquire(80).then((r) => {
      order.push('big');
      r.release(80);
    });
    const small = limiter.acquire(20).then((r) => {
      order.push('small');
      r.release(20);
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual([]);

    // Refill alone would supply the small waiter's 20 tokens well before
    // the big waiter's 80, but FIFO must still serve big first.
    await vi.advanceTimersByTimeAsync(3_000); // ~30 tokens refilled, enough for small but not big
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(6_000); // ~90 tokens refilled total, enough for big
    await big;
    expect(order).toEqual(['big']);

    await vi.advanceTimersByTimeAsync(2_000); // small's remaining 20 tokens refill
    await small;
    expect(order).toEqual(['big', 'small']);
  });

  it('release is safe to call more than once (idempotent)', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const result = await limiter.acquire(1);
    result.release();
    expect(() => result.release()).not.toThrow();
  });

  it('with no options configured, every call is admitted immediately', async () => {
    const limiter = new RateLimiter({});
    for (let i = 0; i < 1000; i++) {
      const r = await limiter.acquire(1_000_000);
      expect(r.waitedMs).toBe(0);
      r.release();
    }
  });

  it('rejects a request whose estimate exceeds tokensPerMinute capacity instead of queueing it forever', async () => {
    const limiter = new RateLimiter({ tokensPerMinute: 100 });

    await expect(limiter.acquire(150)).rejects.toMatchObject({
      type: 'rate_limited',
      code: 'rate_limit_capacity_exceeded',
    });
  });

  it('an unsatisfiable request does not block a smaller waiter already queued behind capacity', async () => {
    vi.useFakeTimers();
    // 100 tokens/min => 1 token per 600ms.
    const limiter = new RateLimiter({ tokensPerMinute: 100, maxQueueMs: 0 });

    const held = await limiter.acquire(100); // drains the bucket
    held.release(100); // matches actual usage: no net change, bucket stays drained

    // Queues behind the drained bucket, not rejected outright (fits within capacity).
    let smallSettled = false;
    const small = limiter.acquire(10).then((r) => {
      smallSettled = true;
      r.release(10);
    });

    await Promise.resolve();
    expect(smallSettled).toBe(false);

    // A separate, unsatisfiable request must fail fast without disturbing the queue.
    await expect(limiter.acquire(1000)).rejects.toMatchObject({
      code: 'rate_limit_capacity_exceeded',
    });

    await vi.advanceTimersByTimeAsync(6_100); // 10 tokens at 1/600ms
    await small;
    expect(smallSettled).toBe(true);
  });

  it('rejects a non-finite or negative estimatedTokens instead of poisoning a bucket', async () => {
    vi.useFakeTimers();
    // 100 tokens/min => 1 token per 600ms.
    const limiter = new RateLimiter({ tokensPerMinute: 100, maxQueueMs: 0 });

    await expect(limiter.acquire(Number.NaN)).rejects.toMatchObject({ type: 'invalid_params' });
    await expect(limiter.acquire(-1)).rejects.toMatchObject({ type: 'invalid_params' });

    // The bucket must still be enforcing capacity afterward, i.e. not poisoned.
    const held = await limiter.acquire(100);
    held.release(100); // no net change: matches actual usage
    let secondSettled = false;
    const pending = limiter.acquire(1).then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(700); // 1 token at 1/600ms
    await pending;
    expect(secondSettled).toBe(true);
  });

  it('ignores a non-finite actualTokens on release instead of poisoning the tokens bucket', async () => {
    vi.useFakeTimers();
    // 100 tokens/min => 1 token per 600ms.
    const limiter = new RateLimiter({ tokensPerMinute: 100, maxQueueMs: 0 });

    const held = await limiter.acquire(100);
    held.release(Number.NaN); // malformed usage report; must not corrupt the bucket

    // The bucket should behave as if nothing was given back (estimated
    // debit retained, the safe direction), so it's still fully drained.
    let secondSettled = false;
    const pending = limiter.acquire(1).then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    // And critically, the bucket must still be capable of correctly
    // recovering via its normal refill, not permanently stuck (either
    // wedged shut or, worse, silently open) from the NaN it was given.
    await vi.advanceTimersByTimeAsync(700); // 1 token at 1/600ms
    await pending;
    expect(secondSettled).toBe(true);
  });

  it('removing a waiter via abort immediately reschedules the wake around the new head, instead of a stale timer sized for the removed one', async () => {
    vi.useFakeTimers();
    // 60 tokens/min => 1 token/sec refill.
    const limiter = new RateLimiter({ tokensPerMinute: 60, maxQueueMs: 0 });

    const held = await limiter.acquire(60); // drains the bucket completely

    const bigController = new AbortController();
    // Needs 50 tokens: if left ungoverned, the wake this schedules would
    // be ~50s away.
    const big = limiter.acquire(50, bigController.signal);
    const bigAssertion = expect(big).rejects.toMatchObject({ type: 'aborted' });

    // Queues behind `big`. Needs only 2 tokens (~2s away), but before the
    // fix, removing `big` left the stale ~50s wake in place, so `small`
    // would stay stuck for tens of seconds it didn't actually need to wait.
    let smallSettled = false;
    const small = limiter.acquire(2).then((r) => {
      smallSettled = true;
      r.release(2);
    });

    bigController.abort();
    await bigAssertion;

    await vi.advanceTimersByTimeAsync(2_100); // just over `small`'s own ~2s need
    await small;
    expect(smallSettled).toBe(true);

    held.release(60);
  });
});

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

    // Drain the starting capacity of 2, then release both, each release
    // growing the ceiling by 1: 2 -> 3 -> 4.
    const first = await limiter.acquire(0);
    const second = await limiter.acquire(0);
    first.release();
    second.release();

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

    // Two releases would push the ceiling to 2 + 5 + 5 = 12 uncapped;
    // maxCapacity clamps it to 3.
    const first = await limiter.acquire(0);
    const second = await limiter.acquire(0);
    first.release();
    second.release();

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

    for (let i = 0; i < 10; i++) limiter.signalRateLimit(); // would go toward 0 uncapped

    await vi.advanceTimersByTimeAsync(60_000);

    const held = [];
    for (let i = 0; i < 2; i++) {
      held.push(await limiter.acquire(0));
    }

    const third = limiter.acquire(0);
    expect(await isPending(third)).toBe(true);

    for (const h of held) h.release();
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

  it('aimd is ignored entirely when requestsPerMinute is not set', () => {
    const limiter = new RateLimiter({
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 },
    });

    expect(() => limiter.signalRateLimit()).not.toThrow();
    expect(() => limiter.reactToRateLimitHint({ remainingRequests: 0 })).not.toThrow();
  });
});
