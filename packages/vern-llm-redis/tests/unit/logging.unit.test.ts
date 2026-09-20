import { describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../src/circuitBreaker.js';
import { createAdapterLogger } from '../../src/internal/logger.utils.js';
import { redisRateLimit } from '../../src/rateLimit.js';
import { waitFor } from '../breakerHelpers.js';
import { fakeRedisClient } from '../helpers.js';

import type { Logger } from 'vern-llm';

function logger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

describe('createAdapterLogger', () => {
  it('reports in the shared [VernLLM] shape with the error in meta', () => {
    const sink = logger();
    const log = createAdapterLogger('redisThing', sink);

    log.failure('release', new Error('boom'), 'k1');

    expect(sink.error).toHaveBeenCalledWith(
      '[VernLLM] redisThing: release failed for key "k1"',
      expect.objectContaining({ message: 'boom', key: 'k1', stack: expect.any(String) }),
    );
  });

  it('omits the key when there is none, and copes with a non Error rejection', () => {
    const sink = logger();
    createAdapterLogger('redisThing', sink).failure('subscribe', 'plain string');

    expect(sink.error).toHaveBeenCalledWith('[VernLLM] redisThing: subscribe failed', {
      message: 'plain string',
      stack: undefined,
    });
  });

  it('defaults to the console until a logger is adopted', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createAdapterLogger('redisThing', undefined);

    log.failure('op', new Error('x'));
    expect(spy).toHaveBeenCalledTimes(1);

    const adopted = logger();
    log.adopt(adopted);
    log.failure('op', new Error('y'));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(adopted.error).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('an explicit logger is never replaced by the one VernLLM hands over', () => {
    const own = logger();
    const handed = logger();
    const log = createAdapterLogger('redisThing', own);

    log.adopt(handed);
    log.failure('op', new Error('x'));

    expect(own.error).toHaveBeenCalledTimes(1);
    expect(handed.error).not.toHaveBeenCalled();
  });

  it("'silent' discards everything and also survives adopt", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handed = logger();
    const log = createAdapterLogger('redisThing', 'silent');

    log.adopt(handed);
    log.failure('op', new Error('x'));

    expect(spy).not.toHaveBeenCalled();
    expect(handed.error).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('mute stops all output', () => {
    const sink = logger();
    const log = createAdapterLogger('redisThing', sink);

    log.mute();
    log.failure('op', new Error('x'));

    expect(sink.error).not.toHaveBeenCalled();
  });
});

describe('adapters follow the logger they are handed', () => {
  it('redisRateLimit reports a failed release through the adopted logger', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([1, '0', '1', '-1']);
    const limiter = redisRateLimit(redis, { fairQueue: false, maxConcurrent: 1 });
    const sink = logger();
    limiter.setLogger?.(sink);

    const held = await limiter.acquire(1);
    redis.eval.mockRejectedValue(new Error('down'));
    held.release();
    await waitFor(() => expect(sink.error).toHaveBeenCalled());

    expect(sink.error).toHaveBeenCalledWith(
      '[VernLLM] redisRateLimit: concurrency release failed',
      expect.objectContaining({ message: 'down' }),
    );
    limiter.dispose();
  });

  it('redisRateLimit with its own logger ignores the handed one', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([1, '0', '1', '-1']);
    const own = logger();
    const limiter = redisRateLimit(redis, { fairQueue: false, maxConcurrent: 1, logger: own });
    const handed = logger();
    limiter.setLogger?.(handed);

    const held = await limiter.acquire(1);
    redis.eval.mockRejectedValue(new Error('down'));
    held.release();
    await waitFor(() => expect(own.error).toHaveBeenCalled());

    expect(handed.error).not.toHaveBeenCalled();
    limiter.dispose();
  });

  it('redisCircuitBreaker reports through the adopted logger, with the key', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('down'));
    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });
    const sink = logger();
    breaker.setLogger?.(sink);

    breaker.recordFailure('m');
    await waitFor(() => expect(sink.error).toHaveBeenCalled());

    expect(sink.error).toHaveBeenCalledWith(
      '[VernLLM] redisCircuitBreaker: recordFailure transition failed for key "cb"',
      expect.objectContaining({ message: 'down', key: 'cb' }),
    );
    breaker.dispose();
  });

  it("logger: 'silent' on the adapter suppresses failures entirely", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('down'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, logger: 'silent' });

    breaker.recordFailure('m');
    await new Promise((r) => setTimeout(r, 10));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    breaker.dispose();
  });
});
