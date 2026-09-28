import { RateLimiter } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QUEUE_SCRIPT } from '../../../src/internal/rate-limit/scripts.js';
import { redisRateLimit } from '../../../src/rateLimit.js';
import { waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient, fakeSubscriber } from '../../helpers.js';

const ok = (avail = 1, cap = 10) => [1, String(avail), String(cap), '-1'];
const miss = (waitMs = -1) => [0, '0', '10', String(waitMs)];

/** Every QUEUE_SCRIPT call with the given op. */
const queueOps = (redis: ReturnType<typeof fakeRedisClient>, op: string) =>
  redis.eval.mock.calls.filter((call) => call[0] === QUEUE_SCRIPT && call[3] === op);

describe('redisRateLimit maxQueueSize', () => {
  /**
   * A fake Redis whose takes always miss and whose shared line refuses
   * an `enter` once it holds `size` waiters, counting only the waiters
   * this test adds, the way QUEUE_SCRIPT counts every process's.
   */
  function fullAfter(size: number) {
    const redis = fakeRedisClient();
    const line = new Set<string>();
    redis.eval.mockImplementation(async (script, _numKeys, _key, op, id) => {
      if (script !== QUEUE_SCRIPT) return miss(50);
      const waiter = String(id);
      if (op === 'enter' && !line.has(waiter)) {
        if (line.size >= size) return [0, line.size, 1];
        line.add(waiter);
      }
      if (op === 'leave') line.delete(waiter);
      return [0, line.size, 0];
    });
    return { redis, line };
  }

  it('rejects a further waiter once the shared line holds maxQueueSize, even without fairQueue', async () => {
    const { redis } = fullAfter(1);
    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      requestsPerMinute: 1,
      maxQueueSize: 1,
      maxQueueMs: 1000,
    });

    const controller = new AbortController();
    const first = limiter.acquire(1, controller.signal).catch((e: unknown) => e);
    await waitFor(() => expect(queueOps(redis, 'enter')).toHaveLength(1));

    await expect(limiter.acquire(1)).rejects.toMatchObject({ code: 'rate_limit_queue_full' });

    controller.abort();
    await first;
  });

  it('sends maxQueueSize to the shared line, where every process is counted', async () => {
    const { redis } = fullAfter(5);
    const limiter = redisRateLimit(redis, {
      requestsPerMinute: 1,
      maxQueueSize: 3,
      maxQueueMs: 1000,
    });

    const controller = new AbortController();
    const waiter = limiter.acquire(1, controller.signal).catch((e: unknown) => e);
    await waitFor(() => expect(queueOps(redis, 'enter')).toHaveLength(1));
    controller.abort();
    await waiter;

    expect(queueOps(redis, 'enter')[0]!.at(-1)).toBe(3);
  });

  it('without fairQueue or maxQueueSize, a waiting call never touches the line', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(miss(50));
    const limiter = redisRateLimit(redis, { fairQueue: false, requestsPerMinute: 1 });

    const controller = new AbortController();
    const waiter = limiter.acquire(1, controller.signal).catch((e: unknown) => e);
    await waitFor(() => expect(redis.eval.mock.calls.length).toBeGreaterThan(1));
    controller.abort();
    await waiter;

    expect(redis.eval.mock.calls.some((call) => call[0] === QUEUE_SCRIPT)).toBe(false);
  });

  it('a waiter counted without fairQueue renews its place while it waits, and leaves after', async () => {
    const { redis, line } = fullAfter(5);
    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      requestsPerMinute: 1,
      maxQueueSize: 2,
      maxQueueMs: 1000,
    });

    const controller = new AbortController();
    const waiter = limiter.acquire(1, controller.signal).catch((e: unknown) => e);
    await waitFor(() => expect(queueOps(redis, 'check').length).toBeGreaterThan(0), 2000);
    controller.abort();
    await waiter;

    expect(queueOps(redis, 'leave')).toHaveLength(1);
    expect(line.size).toBe(0);
  });

  it('an uncontended call never counts against the queue', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(ok());
    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      requestsPerMinute: 10,
      maxQueueSize: 1,
    });

    for (let i = 0; i < 5; i++) await expect(limiter.acquire(1)).resolves.toBeDefined();
  });

  it('frees the queue seat when a waiter is aborted', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(miss(50));
    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      requestsPerMinute: 1,
      maxQueueSize: 1,
      maxQueueMs: 1000,
    });

    const controller = new AbortController();
    const waiter = limiter.acquire(1, controller.signal).catch((e: unknown) => e);
    await waitFor(() => expect(redis.eval.mock.calls.length).toBeGreaterThan(1));
    controller.abort();
    await waiter;

    const second = new AbortController();
    const next = limiter.acquire(1, second.signal).catch((e: unknown) => e);
    await waitFor(() => expect(redis.eval.mock.calls.length).toBeGreaterThan(3));
    second.abort();
    expect(await next).toMatchObject({ type: 'aborted' });
  });

  it('rejects a negative or fractional maxQueueSize', () => {
    const redis = fakeRedisClient();
    expect(() => redisRateLimit(redis, { fairQueue: false, maxQueueSize: -1 })).toThrowError(
      /maxQueueSize/,
    );
    expect(() => redisRateLimit(redis, { fairQueue: false, maxQueueSize: 1.5 })).toThrowError(
      /maxQueueSize/,
    );
  });
});

describe('redisRateLimit estimateFraction', () => {
  const request = { messages: [{ role: 'user', content: 'x'.repeat(400) }], max_tokens: 100 };

  it('scales the pre-flight estimate down, rounding up', () => {
    const limiter = redisRateLimit(fakeRedisClient(), { fairQueue: false, estimateFraction: 0.5 });
    expect(limiter.estimate(request as never)).toBe(100); // (100 + 100) * 0.5
  });

  it('clamps a fraction above 1 to 1, and defaults to no scaling', () => {
    const redis = fakeRedisClient();
    expect(
      redisRateLimit(redis, { fairQueue: false, estimateFraction: 5 }).estimate(request as never),
    ).toBe(200);
    expect(redisRateLimit(redis, { fairQueue: false }).estimate(request as never)).toBe(200);
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects %s', (fraction) => {
    expect(() =>
      redisRateLimit(fakeRedisClient(), { fairQueue: false, estimateFraction: fraction }),
    ).toThrowError(/estimateFraction/);
  });
});

describe('redisRateLimit failure handling', () => {
  it('rolls back the buckets it already took when Redis fails between two takes', async () => {
    const redis = fakeRedisClient();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    redis.eval
      .mockResolvedValueOnce(ok()) // concurrency lease taken
      .mockRejectedValueOnce(new Error('blip')) // rpm take fails
      .mockResolvedValue(1); // rollback succeeds

    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      maxConcurrent: 1,
      requestsPerMinute: 5,
    });

    await expect(limiter.acquire(1)).rejects.toMatchObject({
      name: 'LLMError',
      type: 'network',
      code: 'connection_failed',
      message: 'Redis acquire failed: blip',
      cause: expect.objectContaining({ message: 'blip' }),
    });
    const rollback = redis.eval.mock.calls[2]!;
    expect(rollback[2]).toBe('vernllm:rl:concurrency');
    expect(rollback[3]).toEqual(expect.any(String)); // the lease id it took
    errors.mockRestore();
  });

  it('passes its own rate limit errors through unwrapped', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(ok());
    const limiter = redisRateLimit(redis, { fairQueue: false, tokensPerMinute: 10 });

    await expect(limiter.acquire(50)).rejects.toMatchObject({
      type: 'rate_limited',
      code: 'rate_limit_capacity_exceeded',
    });
  });

  it('wraps a Redis failure in readState the same way', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('down'));
    const limiter = redisRateLimit(redis, { requestsPerMinute: 5 });

    await expect(limiter.readState()).rejects.toMatchObject({
      type: 'network',
      code: 'connection_failed',
      message: 'Redis readState failed: down',
    });
  });

  it('wraps a non Error rejection too', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue('socket gone');
    const limiter = redisRateLimit(redis, { fairQueue: false, requestsPerMinute: 5 });

    await expect(limiter.acquire(1)).rejects.toMatchObject({
      code: 'connection_failed',
      message: 'Redis acquire failed: socket gone',
      cause: 'socket gone',
    });
  });

  it('a failed rollback is reported but never masks the original error', async () => {
    const redis = fakeRedisClient();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    redis.eval
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('original'))
      .mockRejectedValueOnce(new Error('rollback failed'));

    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      maxConcurrent: 1,
      requestsPerMinute: 5,
    });

    await expect(limiter.acquire(1)).rejects.toMatchObject({
      code: 'connection_failed',
      cause: expect.objectContaining({ message: 'original' }),
    });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('release, AIMD and refund failures are logged, not thrown as unhandled rejections', async () => {
    const redis = fakeRedisClient();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    redis.eval.mockResolvedValue(ok());
    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      maxConcurrent: 1,
      tokensPerMinute: 100,
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 },
    });
    const held = await limiter.acquire(50);

    redis.eval.mockRejectedValue(new Error('down'));
    held.release(10, true);
    limiter.signalRateLimit();
    limiter.reactToRateLimitHint({ remainingRequests: 0 });
    await new Promise((r) => setTimeout(r, 20));

    expect(errors.mock.calls.length).toBeGreaterThanOrEqual(3);
    errors.mockRestore();
  });

  it('stays quiet after dispose, and detaches from the subscriber', async () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const unsubscribe = vi.fn(async () => undefined);
    Object.assign(subscriber, { unsubscribe });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    redis.eval.mockResolvedValue(ok());
    const limiter = redisRateLimit(redis, { fairQueue: false, maxConcurrent: 1, subscriber });
    const held = await limiter.acquire(1);

    limiter.dispose();
    limiter.dispose();
    redis.eval.mockRejectedValue(new Error('closed'));
    held.release();
    await new Promise((r) => setTimeout(r, 20));

    expect(unsubscribe).toHaveBeenCalledWith('vernllm:rl:wake');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('rejects a non positive concurrencyLeaseMs', () => {
    expect(() =>
      redisRateLimit(fakeRedisClient(), { fairQueue: false, concurrencyLeaseMs: 0 }),
    ).toThrowError(/concurrencyLeaseMs/);
  });
});

describe('redisRateLimit remaining validation', () => {
  it.each([0, -1, Number.NaN, Infinity])('rejects queueLeaseMs %s', (value) => {
    expect(() => redisRateLimit(fakeRedisClient(), { queueLeaseMs: value })).toThrowError(
      /queueLeaseMs/,
    );
  });
});

describe('redisRateLimit background failure reporting', () => {
  afterEach(() => vi.useRealTimers());

  const sink = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('a failed lease renewal is logged and does not stop the heartbeat', async () => {
    vi.useFakeTimers();
    const redis = fakeRedisClient();
    const logger = sink();
    redis.eval.mockResolvedValueOnce(ok(0, 1));
    const limiter = redisRateLimit(redis, {
      fairQueue: false,
      maxConcurrent: 1,
      concurrencyLeaseMs: 300,
      logger,
    });
    const held = await limiter.acquire(1);

    redis.eval.mockRejectedValue(new Error('renew failed'));
    await vi.advanceTimersByTimeAsync(250);

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] redisRateLimit: lease renewal failed',
      expect.objectContaining({ message: 'renew failed' }),
    );
    held.release();
    limiter.dispose();
  });

  it('a failed subscribe is logged with the wake channel', async () => {
    const subscriber = fakeSubscriber();
    subscriber.subscribe.mockRejectedValue(new Error('no pubsub'));
    const logger = sink();

    const limiter = redisRateLimit(fakeRedisClient(), { subscriber, logger, keyPrefix: 'rl' });

    await waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] redisRateLimit: subscribe failed for key "rl:wake"',
      expect.objectContaining({ message: 'no pubsub', key: 'rl:wake' }),
    );
    limiter.dispose();
  });

  it('dispose swallows a failing unsubscribe', async () => {
    const subscriber = fakeSubscriber();
    Object.assign(subscriber, { unsubscribe: vi.fn().mockRejectedValue(new Error('gone')) });
    const limiter = redisRateLimit(fakeRedisClient(), { subscriber });

    expect(() => limiter.dispose()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('redisRateLimit fair queue waiting', () => {
  /** A Redis whose shared line always has someone ahead, and whose capacity never frees. */
  function busyLine(leave: 'ok' | 'fail') {
    const redis = fakeRedisClient();
    redis.eval.mockImplementation(
      async (script: string, _keys: number, _key: string, op: string) => {
        if (script === QUEUE_SCRIPT) {
          if (op === 'leave') {
            if (leave === 'fail') throw new Error('leave failed');
            return [0, 0];
          }
          return [0, 2]; // peek, enter and check: not the head, two waiting
        }
        return miss(-1);
      },
    );
    return redis;
  }

  it('a waiter that is not at the head waits for the line to advance, woken by the subscriber path', async () => {
    const redis = busyLine('ok');
    const limiter = redisRateLimit(redis, {
      maxConcurrent: 1,
      subscriber: fakeSubscriber(),
      pollIntervalMs: 15,
      maxQueueMs: 1000,
    });
    const controller = new AbortController();

    const waiting = limiter.acquire(1, controller.signal).catch((e: unknown) => e);
    await waitFor(() => {
      const checks = redis.eval.mock.calls.filter((call) => call[3] === 'check');
      expect(checks.length).toBeGreaterThanOrEqual(2);
    });
    controller.abort();

    expect(await waiting).toMatchObject({ type: 'aborted' });
    expect(redis.eval.mock.calls.some((call) => call[3] === 'leave')).toBe(true);
    limiter.dispose();
  });

  it('the same waiter without a subscriber falls back to sleeping', async () => {
    const redis = busyLine('ok');
    const limiter = redisRateLimit(redis, {
      maxConcurrent: 1,
      pollIntervalMs: 15,
      maxQueueMs: 1000,
    });
    const controller = new AbortController();

    const waiting = limiter.acquire(1, controller.signal).catch((e: unknown) => e);
    await waitFor(() => {
      const checks = redis.eval.mock.calls.filter((call) => call[3] === 'check');
      expect(checks.length).toBeGreaterThanOrEqual(2);
    });
    controller.abort();

    expect(await waiting).toMatchObject({ type: 'aborted' });
    limiter.dispose();
  });

  it('times out while waiting in line, and still leaves it', async () => {
    const redis = busyLine('ok');
    const limiter = redisRateLimit(redis, {
      maxConcurrent: 1,
      pollIntervalMs: 10,
      maxQueueMs: 60,
    });

    await expect(limiter.acquire(1)).rejects.toMatchObject({ code: 'rate_limit_queue_timeout' });
    expect(redis.eval.mock.calls.some((call) => call[3] === 'leave')).toBe(true);
    limiter.dispose();
  });

  it('a failure to leave the line is logged, and does not replace the real outcome', async () => {
    const redis = busyLine('fail');
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const limiter = redisRateLimit(redis, {
      maxConcurrent: 1,
      pollIntervalMs: 10,
      maxQueueMs: 60,
      logger,
    });

    await expect(limiter.acquire(1)).rejects.toMatchObject({ code: 'rate_limit_queue_timeout' });

    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] redisRateLimit: queue leave failed',
      expect.objectContaining({ message: 'leave failed' }),
    );
    limiter.dispose();
  });
});

describe('redisRateLimit validates limits exactly like core', () => {
  /** What a constructor threw, as the fields a caller would branch on. */
  function thrown(build: () => unknown) {
    try {
      build();
    } catch (error) {
      const { name, type, code, message } = error as Record<string, unknown>;
      return { name, type, code, message };
    }
    return undefined;
  }

  it.each([
    { requestsPerMinute: -1 },
    { requestsPerMinute: 0.5 },
    { tokensPerMinute: Number.NaN },
    { tokensPerMinute: Infinity },
    { maxConcurrent: 1.5 },
    { maxConcurrent: -1 },
    { maxQueueSize: 2.5 },
    { maxQueueMs: -1 },
    { maxQueueMs: 2_147_483_648 },
    { aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 } },
    {
      requestsPerMinute: 10,
      aimd: {
        increaseBy: 1,
        decreaseFactor: 0.5,
        minCapacity: 1,
        maxCapacity: 10,
        proactiveFloor: -1,
      },
    },
    {
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 0.5, maxCapacity: 10 },
    },
    {
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: Number.NaN },
    },
    {
      requestsPerMinute: 10,
      aimd: { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 20, maxCapacity: 10 },
    },
  ])('throws the same error as core for %j', (options) => {
    const core = thrown(() => new RateLimiter(options));
    const redis = thrown(() => redisRateLimit(fakeRedisClient(), options));

    expect(core).toMatchObject({ name: 'LLMError', type: 'invalid_params' });
    expect(redis).toEqual(core);
  });
});
