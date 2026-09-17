import { describe, expect, it, vi } from 'vitest';

import { redisRateLimit } from '../../src/rateLimit.js';
import { fakeRedisClient, fakeSubscriber } from '../helpers.js';

/** Matches TAKE_SCRIPT's return shape: [ok, avail, cap, waitMs]. */
function takeResult(
  ok: 0 | 1,
  avail: number,
  cap: number,
  waitMs: number,
): [number, string, string, string] {
  return [ok, String(avail), String(cap), String(waitMs)];
}

describe('redisRateLimit', () => {
  it('estimate delegates to the default token heuristic when none is supplied', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis);

    const request = { model: 'm', messages: [{ role: 'user', content: 'hello' }] } as never;
    expect(limiter.estimate(request)).toBeGreaterThan(0);
  });

  it('estimate uses a custom estimateTokens function when supplied', () => {
    const redis = fakeRedisClient();
    const estimateTokens = vi.fn(() => 42);
    const limiter = redisRateLimit(redis, { estimateTokens });

    const request = { model: 'm', messages: [] } as never;
    expect(limiter.estimate(request)).toBe(42);
    expect(estimateTokens).toHaveBeenCalledWith(request);
  });

  it('acquire resolves immediately when capacity is available', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 9, 10, -1));

    const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });
    const result = await limiter.acquire(1);

    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.release).toBe('function');
  });

  it('acquire rolls back every bucket already taken when a later bucket in the chain fails', async () => {
    const redis = fakeRedisClient();
    redis.eval
      .mockResolvedValueOnce(takeResult(1, 9, 10, -1)) // rpm take succeeds
      .mockResolvedValueOnce(takeResult(0, 0, 100, 500)) // tpm take fails
      .mockResolvedValueOnce('5') // rollback GIVE for rpm
      .mockResolvedValueOnce(takeResult(1, 9, 10, -1)) // rpm take succeeds again
      .mockResolvedValueOnce(takeResult(1, 100, 100, -1)); // tpm take succeeds

    const limiter = redisRateLimit(redis, { requestsPerMinute: 10, tokensPerMinute: 100 });
    await limiter.acquire(50);

    // 5 eval calls total: take, take(fail), give(rollback), take, take.
    expect(redis.eval).toHaveBeenCalledTimes(5);
  });

  it('acquire sleeps the exact computed wait time for a requests/min block, not a fixed poll interval', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval
        .mockResolvedValueOnce(takeResult(0, 0, 10, 2000))
        .mockResolvedValueOnce(takeResult(1, 9, 10, -1));

      const limiter = redisRateLimit(redis, { requestsPerMinute: 10, pollIntervalMs: 99_999 });
      const promise = limiter.acquire(1);

      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result).toBeDefined();
      expect(redis.eval).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps a very long computed wait at MAX_WAKE_DELAY_MS instead of sleeping the full duration in one step', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval
        .mockResolvedValueOnce(takeResult(0, 0, 10, 60_000))
        .mockResolvedValueOnce(takeResult(1, 9, 10, -1));

      const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });
      const promise = limiter.acquire(1);

      // Should not resolve after only 5s, the cap, since a real 60s wait
      // still needs another loop iteration after the capped sleep.
      await vi.advanceTimersByTimeAsync(5000);
      expect(redis.eval).toHaveBeenCalledTimes(2);

      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('acquire throws once maxQueueMs is exceeded', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValue(takeResult(0, 0, 10, 100_000));

      const limiter = redisRateLimit(redis, { requestsPerMinute: 10, maxQueueMs: 1000 });
      const promise = limiter.acquire(1);
      const assertion = expect(promise).rejects.toMatchObject({ type: 'rate_limited' });

      await vi.advanceTimersByTimeAsync(6000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('acquire rejects immediately when the signal is already aborted', async () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });

    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(1, controller.signal)).rejects.toMatchObject({ type: 'aborted' });
  });

  it('acquire rejects when the signal aborts while waiting on a deterministic wait', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValue(takeResult(0, 0, 10, 10_000));

      const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });
      const controller = new AbortController();

      const promise = limiter.acquire(1, controller.signal);
      const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to polling for a concurrency-only block without a subscriber', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval
        .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
        .mockResolvedValueOnce(takeResult(1, 0, 1, -1));

      const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 500 });
      const promise = limiter.acquire(1);

      await vi.advanceTimersByTimeAsync(500);
      await promise;

      expect(redis.eval).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes on a subscriber message instead of waiting the full poll interval for a concurrency block', async () => {
    const redis = fakeRedisClient();
    redis.eval
      .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
      .mockResolvedValueOnce(takeResult(1, 0, 1, -1));

    const subscriber = fakeSubscriber();
    const limiter = redisRateLimit(redis, {
      maxConcurrent: 1,
      pollIntervalMs: 60_000,
      subscriber,
    });

    const promise = limiter.acquire(1);

    // A real macrotask tick, not just "eval was called", since eval's
    // mock call count increments synchronously at invocation while the
    // waiter registration only happens after that call's promise
    // resolves and the acquire loop's continuation runs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redis.eval).toHaveBeenCalledTimes(1);

    subscriber.emit('vernllm:rl:wake', 'vernllm:rl:concurrency');

    await expect(promise).resolves.toBeDefined();
  });

  it('release gives the concurrency slot back exactly once, even if called twice', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 0, 1, -1));

    const limiter = redisRateLimit(redis, { maxConcurrent: 1 });
    const { release } = await limiter.acquire(1);

    redis.eval.mockClear();
    release();
    release();

    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('release reconciles the tokens bucket by the positive difference between estimated and actual usage', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 50, 100, -1));

    const limiter = redisRateLimit(redis, { tokensPerMinute: 100 });
    const { release } = await limiter.acquire(50);

    redis.eval.mockClear();
    release(20); // used less than the 50 estimated, gives back 30

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('local key = KEYS[1]'),
      1,
      'vernllm:rl:tpm',
      100,
      30,
      'vernllm:rl:wake',
      'permin',
    );
  });

  it('release charges the tokens bucket the negative difference when actualTokens exceeds the estimate', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 50, 100, -1));

    const limiter = redisRateLimit(redis, { tokensPerMinute: 100 });
    const { release } = await limiter.acquire(50);

    redis.eval.mockClear();
    release(80); // used more than the 50 estimated, charges the extra 30

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('local key = KEYS[1]'),
      1,
      'vernllm:rl:tpm',
      100,
      -30,
      'vernllm:rl:wake',
      'permin',
    );
  });

  it('release does not touch the tokens bucket when actualTokens exactly matches the estimate', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 50, 100, -1));

    const limiter = redisRateLimit(redis, { tokensPerMinute: 100 });
    const { release } = await limiter.acquire(50);

    redis.eval.mockClear();
    release(50); // used exactly what was estimated, no reconciliation needed

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('release grows the AIMD ceiling only when success is true', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 9, 10, -1));

    const limiter = redisRateLimit(redis, {
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 20 },
    });
    const { release } = await limiter.acquire(1);

    redis.eval.mockClear();
    release(undefined, true);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("if op == 'grow'"),
      1,
      'vernllm:rl:rpm',
      'grow',
      1,
      1,
      20,
      10,
    );
  });

  it('release does not resize when success is false, the default', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 9, 10, -1));

    const limiter = redisRateLimit(redis, {
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 20 },
    });
    const { release } = await limiter.acquire(1);

    redis.eval.mockClear();
    release();

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('signalRateLimit shrinks the AIMD ceiling', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, {
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 20 },
    });

    limiter.signalRateLimit();

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("if op == 'grow'"),
      1,
      'vernllm:rl:rpm',
      'shrink',
      0.5,
      1,
      20,
      10,
    );
  });

  it('signalRateLimit is a no-op without aimd configured', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });

    limiter.signalRateLimit();

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('reactToRateLimitHint shrinks once remainingRequests reaches the proactive floor', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, {
      requestsPerMinute: 10,
      aimd: {
        increaseBy: 1,
        decreaseFactor: 0.5,
        minCapacity: 1,
        maxCapacity: 20,
        proactiveFloor: 5,
      },
    });

    limiter.reactToRateLimitHint({ remainingRequests: 5 });

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("if op == 'grow'"),
      1,
      'vernllm:rl:rpm',
      'shrink',
      0.5,
      1,
      20,
      10,
    );
  });

  it('reactToRateLimitHint does nothing above the proactive floor', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, {
      requestsPerMinute: 10,
      aimd: {
        increaseBy: 1,
        decreaseFactor: 0.5,
        minCapacity: 1,
        maxCapacity: 20,
        proactiveFloor: 5,
      },
    });

    limiter.reactToRateLimitHint({ remainingRequests: 6 });

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('reactToRateLimitHint does nothing without aimd, without a hint, or without proactiveFloor set', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });

    limiter.reactToRateLimitHint({ remainingRequests: 0 });
    limiter.reactToRateLimitHint(undefined);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('getState is intentionally not implemented', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis);

    expect(limiter.getState).toBeUndefined();
  });

  it('throws at construction when aimd is set without requestsPerMinute', () => {
    const redis = fakeRedisClient();

    expect(() =>
      redisRateLimit(redis, {
        aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 },
      }),
    ).toThrow(/requestsPerMinute/);
  });

  it('throws at construction when aimd.minCapacity exceeds aimd.maxCapacity', () => {
    const redis = fakeRedisClient();

    expect(() =>
      redisRateLimit(redis, {
        requestsPerMinute: 10,
        aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 10, maxCapacity: 5 },
      }),
    ).toThrow(/minCapacity/);
  });

  it('throws at construction when aimd.decreaseFactor is out of (0, 1]', () => {
    const redis = fakeRedisClient();

    expect(() =>
      redisRateLimit(redis, {
        requestsPerMinute: 10,
        aimd: { increaseBy: 1, decreaseFactor: 1.5, minCapacity: 1, maxCapacity: 10 },
      }),
    ).toThrow(/decreaseFactor/);
  });

  it('throws at construction when aimd.minCapacity or maxCapacity is below 1', () => {
    const redis = fakeRedisClient();

    expect(() =>
      redisRateLimit(redis, {
        requestsPerMinute: 10,
        aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 0, maxCapacity: 10 },
      }),
    ).toThrow(/at least 1/);
  });

  it('sleepOrAbort rejects on its own pre-check when the signal aborts while a take is still in flight', async () => {
    const redis = fakeRedisClient();
    let resolveEval: ((value: unknown) => void) | undefined;
    redis.eval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEval = resolve;
        }),
    );

    const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });
    const controller = new AbortController();

    const promise = limiter.acquire(1, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

    // Abort while the very first take is still pending, before the code
    // has reached its own wait branch, so by the time it does reach
    // sleepOrAbort the signal is already aborted rather than aborting
    // during the sleep itself.
    controller.abort();
    resolveEval?.(takeResult(0, 0, 10, 2000));

    await assertion;
  });

  it('ignores a wake message published on an unrelated channel', async () => {
    const redis = fakeRedisClient();
    redis.eval
      .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
      .mockResolvedValueOnce(takeResult(1, 0, 1, -1));

    const subscriber = fakeSubscriber();
    const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 60_000, subscriber });

    const promise = limiter.acquire(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    subscriber.emit('some:other:channel', 'vernllm:rl:concurrency');

    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    subscriber.emit('vernllm:rl:wake', 'vernllm:rl:concurrency');
    await expect(promise).resolves.toBeDefined();
  });

  it('registers a second waiter on a key another call is already waiting on', async () => {
    const redis = fakeRedisClient();
    redis.eval
      .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
      .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
      .mockResolvedValueOnce(takeResult(1, 0, 1, -1))
      .mockResolvedValueOnce(takeResult(1, 0, 1, -1));

    const subscriber = fakeSubscriber();
    const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 60_000, subscriber });

    const first = limiter.acquire(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = limiter.acquire(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    subscriber.emit('vernllm:rl:wake', 'vernllm:rl:concurrency');

    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });

  it('falls through to the poll timer itself when no wake message ever arrives, with a subscriber present', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval
        .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
        .mockResolvedValueOnce(takeResult(1, 0, 1, -1));

      const subscriber = fakeSubscriber();
      const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 500, subscriber });

      const promise = limiter.acquire(1);
      await vi.advanceTimersByTimeAsync(500);

      await expect(promise).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second waiter on the same key is unaffected when the first times out via the poll fallback', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      let calls = 0;
      redis.eval.mockImplementation(async () => {
        calls += 1;
        // The first two calls are each waiter's initial, failing take.
        // Every retry after that succeeds, regardless of how many
        // retries the timer/wake ordering produces.
        return calls <= 2 ? takeResult(0, 0, 1, -1) : takeResult(1, 0, 1, -1);
      });

      const subscriber = fakeSubscriber();
      const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 500, subscriber });

      const first = limiter.acquire(1);
      await vi.advanceTimersByTimeAsync(0);
      const second = limiter.acquire(1);
      await vi.advanceTimersByTimeAsync(0);

      // First waiter's poll fires and it retries; the waiter set for
      // this key still has the second waiter registered in it, so it
      // must not have been deleted out from under it by the first's
      // own cleanup.
      await vi.advanceTimersByTimeAsync(500);

      subscriber.emit('vernllm:rl:wake', 'vernllm:rl:concurrency');
      await expect(second).resolves.toBeDefined();
      await expect(first).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a waiter aborting while blocked on a subscriber-backed concurrency wait cleans itself up', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(takeResult(0, 0, 1, -1));

    const subscriber = fakeSubscriber();
    const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 60_000, subscriber });
    const controller = new AbortController();

    const promise = limiter.acquire(1, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await assertion;
  });

  it('a waiter with a signal, once woken by a message rather than aborted, still cleans up its abort listener', async () => {
    const redis = fakeRedisClient();
    redis.eval
      .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
      .mockResolvedValueOnce(takeResult(1, 0, 1, -1));

    const subscriber = fakeSubscriber();
    const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 60_000, subscriber });
    const controller = new AbortController();

    const promise = limiter.acquire(1, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));

    subscriber.emit('vernllm:rl:wake', 'vernllm:rl:concurrency');
    await expect(promise).resolves.toBeDefined();
  });

  it('never times out while blocked when maxQueueMs is 0, meaning no timeout at all', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval
        .mockResolvedValueOnce(takeResult(0, 0, 10, 5000))
        .mockResolvedValueOnce(takeResult(1, 9, 10, -1));

      const limiter = redisRateLimit(redis, { requestsPerMinute: 10, maxQueueMs: 0 });
      const promise = limiter.acquire(1);

      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reactToRateLimitHint defaults proactiveFloor to 0 when aimd omits it, never shrinking', () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, {
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 20 },
    });

    limiter.reactToRateLimitHint({ remainingRequests: 0 });

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('a poll timer that fires naturally still cleans up its abort listener when a signal was provided', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval
        .mockResolvedValueOnce(takeResult(0, 0, 1, -1))
        .mockResolvedValueOnce(takeResult(1, 0, 1, -1));

      const subscriber = fakeSubscriber();
      const limiter = redisRateLimit(redis, { maxConcurrent: 1, pollIntervalMs: 500, subscriber });
      const controller = new AbortController();

      const promise = limiter.acquire(1, controller.signal);
      // The timer fires on its own, never woken and never aborted, so
      // this exercises the timer callback's cleanup with onAbort
      // actually defined (a signal was passed), not undefined.
      await vi.advanceTimersByTimeAsync(500);

      await expect(promise).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws at construction when requestsPerMinute, tokensPerMinute, or maxConcurrent is negative or not finite', () => {
    const redis = fakeRedisClient();

    expect(() => redisRateLimit(redis, { requestsPerMinute: -1 })).toThrow(/requestsPerMinute/);
    expect(() => redisRateLimit(redis, { tokensPerMinute: NaN })).toThrow(/tokensPerMinute/);
    expect(() => redisRateLimit(redis, { maxConcurrent: Infinity })).toThrow(/maxConcurrent/);
  });

  it('accepts 0 for requestsPerMinute, tokensPerMinute, or maxConcurrent, meaning unlimited/disabled', () => {
    const redis = fakeRedisClient();

    expect(() => redisRateLimit(redis, { requestsPerMinute: 0 })).not.toThrow();
    expect(() => redisRateLimit(redis, { tokensPerMinute: 0 })).not.toThrow();
    expect(() => redisRateLimit(redis, { maxConcurrent: 0 })).not.toThrow();
  });

  it('throws at construction when maxQueueMs is negative or not finite', () => {
    const redis = fakeRedisClient();

    expect(() => redisRateLimit(redis, { maxQueueMs: -1 })).toThrow(/maxQueueMs/);
    expect(() => redisRateLimit(redis, { maxQueueMs: NaN })).toThrow(/maxQueueMs/);
  });

  it('accepts 0 for maxQueueMs, meaning no timeout', () => {
    const redis = fakeRedisClient();

    expect(() => redisRateLimit(redis, { maxQueueMs: 0 })).not.toThrow();
  });

  it('throws at construction when pollIntervalMs is 0, negative, or not finite', () => {
    const redis = fakeRedisClient();

    expect(() => redisRateLimit(redis, { pollIntervalMs: 0 })).toThrow(/pollIntervalMs/);
    expect(() => redisRateLimit(redis, { pollIntervalMs: -1 })).toThrow(/pollIntervalMs/);
    expect(() => redisRateLimit(redis, { pollIntervalMs: Infinity })).toThrow(/pollIntervalMs/);
  });

  it('acquire throws for a negative or non-finite estimatedTokens, without touching Redis', async () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });

    await expect(limiter.acquire(-1)).rejects.toMatchObject({ type: 'invalid_params' });
    await expect(limiter.acquire(NaN)).rejects.toMatchObject({ type: 'invalid_params' });
    await expect(limiter.acquire(Infinity)).rejects.toMatchObject({ type: 'invalid_params' });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('acquire fails fast when estimatedTokens exceeds the fixed tokensPerMinute capacity', async () => {
    const redis = fakeRedisClient();
    const limiter = redisRateLimit(redis, { tokensPerMinute: 100 });

    await expect(limiter.acquire(150)).rejects.toMatchObject({
      type: 'rate_limited',
      code: 'rate_limit_capacity_exceeded',
    });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('acquire does not fail fast on estimatedTokens when tokensPerMinute is not set', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(takeResult(1, 0, 10, -1));

    const limiter = redisRateLimit(redis, { requestsPerMinute: 10 });
    await expect(limiter.acquire(1_000_000)).resolves.toBeDefined();
  });
});
