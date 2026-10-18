import { LLMError } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { READ_SCRIPT, RECORD_SCRIPT } from '../../../src/internal/retry-budget/scripts.js';
import { redisRetryBudget } from '../../../src/retryBudget.js';
import { fakeRedisClient } from '../../helpers.js';

const options = { windowMs: 1000, minCalls: 2, retryRatio: 0.5, logger: 'silent' as const };

function quietLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('redisRetryBudget', () => {
  it('sends the record script with the bucket width, retry flag and ttl', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([1, 1]);
    const budget = redisRetryBudget(redis, { ...options, keyPrefix: 'app:rb' });

    budget.recordAttempt(true);
    budget.recordAttempt(false);
    await flush();

    expect(redis.eval).toHaveBeenNthCalledWith(1, RECORD_SCRIPT, 1, 'app:rb:window', 100, 1, 2000);
    expect(redis.eval).toHaveBeenNthCalledWith(2, RECORD_SCRIPT, 1, 'app:rb:window', 100, 0, 2000);
  });

  it('defaults the key to vernllm:rb:window', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([0, 0]);

    await redisRetryBudget(redis, options).readState();

    expect(redis.eval).toHaveBeenCalledWith(READ_SCRIPT, 1, 'vernllm:rb:window', 100);
  });

  it('counts an attempt locally before Redis replies', () => {
    const redis = fakeRedisClient();
    redis.eval.mockReturnValue(new Promise(() => {}));
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(false);
    budget.recordAttempt(true);

    expect(budget.getSnapshot()).toEqual({ attempts: 2, retryRatio: 0.5 });
    expect(() => budget.assertAvailable()).toThrow(LLMError);
  });

  it('replaces the local counts with the shared window from the reply', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([10, 2]);
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(false);
    await flush();

    expect(budget.getSnapshot()).toEqual({ attempts: 10, retryRatio: 0.2 });
    expect(() => budget.assertAvailable()).not.toThrow();
  });

  it('throws the same error as core once the budget is spent', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([4, 2]);
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(true);
    await flush();

    expect(() => budget.assertAvailable()).toThrow(
      expect.objectContaining({
        message: 'Retry budget exhausted',
        type: 'rate_limited',
        code: 'retry_budget_exhausted',
      }),
    );
  });

  it('applies the check on an empty window when minCalls is 0, as core does', () => {
    const budget = redisRetryBudget(fakeRedisClient(), { ...options, minCalls: 0, retryRatio: 0 });

    expect(() => budget.assertAvailable()).toThrow(LLMError);
  });

  it('logs a failed record and keeps the local count', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('Redis is down'));
    const logger = quietLogger();
    const budget = redisRetryBudget(redis, { ...options, keyPrefix: 'k', logger });

    budget.recordAttempt(true);
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] redisRetryBudget: recordAttempt failed for key "k:window"',
      expect.objectContaining({ message: 'Redis is down', key: 'k:window' }),
    );
    expect(budget.getSnapshot()).toEqual({ attempts: 1, retryRatio: 1 });
  });

  it('logs a malformed reply instead of trusting it', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue('OK');
    const logger = quietLogger();
    const budget = redisRetryBudget(redis, { ...options, logger });

    budget.recordAttempt(false);
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] redisRetryBudget: recordAttempt failed for key "vernllm:rb:window"',
      expect.objectContaining({ message: 'Unexpected retry budget script reply: "OK"' }),
    );
    expect(budget.getSnapshot()).toEqual({ attempts: 1, retryRatio: 0 });
  });

  it("uses this process's own budget once no reply has landed for longer than the window", () => {
    vi.useFakeTimers();
    const redis = fakeRedisClient();
    // A Redis that hangs rather than rejecting.
    redis.eval.mockReturnValue(new Promise(() => {}));
    const budget = redisRetryBudget(redis, options);

    vi.advanceTimersByTime(600);
    budget.recordAttempt(true);
    budget.recordAttempt(true);
    vi.advanceTimersByTime(401);

    // Stale: decided by core's budget over this process's attempts, still inside its window.
    expect(budget.getSnapshot()).toEqual({ attempts: 2, retryRatio: 1 });
    expect(() => budget.assertAvailable()).toThrow(LLMError);

    vi.advanceTimersByTime(1000);
    expect(budget.getSnapshot()).toEqual({ attempts: 0, retryRatio: 0 });
    expect(() => budget.assertAvailable()).not.toThrow();
  });

  it("uses this process's own budget once a record fails, and Redis again on the next reply", async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(false);
    budget.recordAttempt(true);
    await flush();

    expect(budget.getSnapshot()).toEqual({ attempts: 2, retryRatio: 0.5 });
    expect(() => budget.assertAvailable()).toThrow(LLMError);

    redis.eval.mockResolvedValueOnce([10, 0]);
    budget.recordAttempt(false);
    await flush();

    expect(budget.getSnapshot()).toEqual({ attempts: 10, retryRatio: 0 });
    expect(() => budget.assertAvailable()).not.toThrow();
  });

  it("switches to this process's own budget when readState fails", async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce([50, 0]);
    const budget = redisRetryBudget(redis, options);
    budget.recordAttempt(true);
    await flush();
    expect(budget.getSnapshot()).toEqual({ attempts: 50, retryRatio: 0 });

    redis.eval.mockRejectedValueOnce(new Error('down'));
    await expect(budget.readState()).rejects.toMatchObject({ type: 'network' });

    expect(budget.getSnapshot()).toEqual({ attempts: 1, retryRatio: 1 });
  });

  it('readState returns the live window and refreshes the local copy', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([8, 6]);
    const budget = redisRetryBudget(redis, options);

    await expect(budget.readState()).resolves.toEqual({ attempts: 8, retryRatio: 0.75 });
    expect(budget.getSnapshot()).toEqual({ attempts: 8, retryRatio: 0.75 });
  });

  it('readState reports an empty window as ratio 0', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([0, 0]);

    await expect(redisRetryBudget(redis, options).readState()).resolves.toEqual({
      attempts: 0,
      retryRatio: 0,
    });
  });

  it('readState rejects with a network LLMError when Redis fails', async () => {
    const redis = fakeRedisClient();
    const cause = new Error('ECONNREFUSED');
    redis.eval.mockRejectedValue(cause);

    await expect(redisRetryBudget(redis, options).readState()).rejects.toMatchObject({
      message: 'Redis readState failed: ECONNREFUSED',
      type: 'network',
      code: 'connection_failed',
      cause,
    });
  });

  it('readState rejects with a network LLMError on a malformed reply', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([3, 5]);

    await expect(redisRetryBudget(redis, options).readState()).rejects.toMatchObject({
      type: 'network',
      code: 'connection_failed',
    });
  });

  it('sends nothing and ignores late replies once disposed', async () => {
    const redis = fakeRedisClient();
    let reply: (value: unknown) => void = () => {};
    redis.eval.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
    redis.eval.mockResolvedValue([50, 50]);
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(false);
    budget.dispose();
    reply([40, 40]);
    await flush();
    budget.recordAttempt(true);
    await budget.readState();

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(budget.getSnapshot()).toEqual({ attempts: 1, retryRatio: 0 });
  });

  it('mutes its logger once disposed', async () => {
    const redis = fakeRedisClient();
    let fail: (error: Error) => void = () => {};
    redis.eval.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    const logger = quietLogger();
    const budget = redisRetryBudget(redis, { ...options, logger });

    budget.recordAttempt(false);
    budget.dispose();
    fail(new Error('late'));
    await flush();

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("adopts VernLLM's logger when it has none of its own", async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('down'));
    const budget = redisRetryBudget(redis, { windowMs: 1000, minCalls: 1, retryRatio: 1 });
    const logger = quietLogger();

    budget.setLogger(logger);
    budget.recordAttempt(false);
    await flush();

    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('keeps its own logger over the one VernLLM hands it', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('down'));
    const own = quietLogger();
    const handed = quietLogger();
    const budget = redisRetryBudget(redis, { ...options, logger: own });

    budget.setLogger(handed);
    budget.recordAttempt(false);
    await flush();

    expect(own.error).toHaveBeenCalledOnce();
    expect(handed.error).not.toHaveBeenCalled();
  });

  it('runs scripts by SHA1 after the first call when the client has evalsha', async () => {
    const redis = Object.assign(fakeRedisClient(), { evalsha: vi.fn(async () => [2, 0]) });
    redis.eval.mockResolvedValue([1, 0]);
    const budget = redisRetryBudget(redis, options);

    await budget.readState();
    await budget.readState();

    expect(redis.eval).toHaveBeenCalledOnce();
    expect(redis.evalsha).toHaveBeenCalledOnce();
  });

  it('throws invalid_params at construction for bad options', () => {
    expect(() => redisRetryBudget(fakeRedisClient(), { ...options, retryRatio: 2 })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it("keeps a later in-flight attempt when an earlier record's reply lands first", async () => {
    const redis = fakeRedisClient();
    const replies: Array<(value: unknown) => void> = [];
    redis.eval.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(false);
    budget.recordAttempt(true);
    // Redis ran only the first script when it replied, so its reply covers one attempt.
    replies[0]!([1, 0]);
    await flush();

    expect(budget.getSnapshot()).toEqual({ attempts: 2, retryRatio: 0.5 });
    expect(() => budget.assertAvailable()).toThrow(LLMError);

    replies[1]!([2, 1]);
    await flush();
    expect(budget.getSnapshot()).toEqual({ attempts: 2, retryRatio: 0.5 });
  });

  it('stops adding back a record once it fails or replies with garbage', async () => {
    const redis = fakeRedisClient();
    redis.eval
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce('garbage')
      .mockResolvedValueOnce([5, 0]);
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(true);
    budget.recordAttempt(true);
    await flush();
    budget.recordAttempt(false);
    await flush();

    // Only the reply counts: neither failed record lingers as in flight.
    expect(budget.getSnapshot()).toEqual({ attempts: 5, retryRatio: 0 });
  });

  it('adds in-flight records to a readState refresh, but returns Redis as is', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce([3, 0]);
    const budget = redisRetryBudget(redis, options);

    budget.recordAttempt(true);

    await expect(budget.readState()).resolves.toEqual({ attempts: 3, retryRatio: 0 });
    expect(budget.getSnapshot()).toEqual({ attempts: 4, retryRatio: 0.25 });
  });
});
