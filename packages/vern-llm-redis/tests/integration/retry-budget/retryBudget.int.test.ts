import { LLMError } from 'vern-llm';
import { describe, expect, vi } from 'vitest';

import { it } from '../../fixtures.js';
import { spyOnScripts, uniquePrefix, waitUntil } from '../../helpers.js';

import type { RedisRetryBudgetAdapter } from '../../../src/retryBudget.js';

/** True once `budget` would refuse a retry. */
function isExhausted(budget: RedisRetryBudgetAdapter): boolean {
  try {
    budget.assertAvailable();
    return false;
  } catch (error) {
    if (error instanceof LLMError && error.code === 'retry_budget_exhausted') return true;
    throw error;
  }
}

describe.concurrent('redisRetryBudget, real Redis', () => {
  it('two processes on one key share one budget', async ({ makeBudget, newConnection }) => {
    const keyPrefix = uniquePrefix('rb');
    const options = { windowMs: 60_000, minCalls: 4, retryRatio: 0.5, keyPrefix };
    const a = makeBudget(options, newConnection());
    const b = makeBudget(options, newConnection());

    // 4 attempts, 3 retries: 0.75, over budget, but only in A so far.
    for (const isRetry of [false, true, true, true]) a.recordAttempt(isRetry);
    await waitUntil(async () => (await a.readState()).attempts === 4);
    expect(isExhausted(b)).toBe(false);

    // B's own first attempt brings back the shared window: 5 attempts, 3 retries, 0.6.
    b.recordAttempt(false);
    await waitUntil(() => b.getSnapshot().attempts === 5);

    expect(b.getSnapshot()).toEqual({ attempts: 5, retryRatio: 0.6 });
    expect(isExhausted(b)).toBe(true);
    await expect(b.readState()).resolves.toEqual({ attempts: 5, retryRatio: 0.6 });
  });

  it('a process that has never recorded learns the shared window from readState', async ({
    makeBudget,
    newConnection,
  }) => {
    const keyPrefix = uniquePrefix('rb');
    const options = { windowMs: 60_000, minCalls: 2, retryRatio: 0.5, keyPrefix };
    const a = makeBudget(options, newConnection());
    const fresh = makeBudget(options, newConnection());

    a.recordAttempt(false);
    a.recordAttempt(true);
    // The local count is 2 at once; wait until Redis has both, which is what `fresh` reads.
    await waitUntil(async () => (await a.readState()).attempts === 2);

    expect(isExhausted(fresh)).toBe(false);
    await fresh.readState();
    expect(isExhausted(fresh)).toBe(true);
  });

  it('different key prefixes keep separate budgets', async ({ makeBudget }) => {
    const options = { windowMs: 60_000, minCalls: 1, retryRatio: 0.5 };
    const a = makeBudget({ ...options, keyPrefix: uniquePrefix('rb') });
    const b = makeBudget({ ...options, keyPrefix: uniquePrefix('rb') });

    a.recordAttempt(true);
    await waitUntil(async () => (await a.readState()).attempts === 1);

    await expect(b.readState()).resolves.toEqual({ attempts: 0, retryRatio: 0 });
  });

  it('minCalls holds a cold start open however high the ratio', async ({ makeBudget }) => {
    const budget = makeBudget({
      windowMs: 60_000,
      minCalls: 3,
      retryRatio: 0,
      keyPrefix: uniquePrefix('rb'),
    });

    budget.recordAttempt(true);
    budget.recordAttempt(true);
    await waitUntil(async () => (await budget.readState()).attempts === 2);
    expect(isExhausted(budget)).toBe(false);

    budget.recordAttempt(true);
    await waitUntil(() => isExhausted(budget));
  });

  it('attempts age out of the window on the Redis clock', async ({ makeBudget }) => {
    const budget = makeBudget({
      windowMs: 400,
      minCalls: 2,
      retryRatio: 0.5,
      keyPrefix: uniquePrefix('rb'),
    });

    budget.recordAttempt(false);
    budget.recordAttempt(true);
    await waitUntil(() => isExhausted(budget));

    await waitUntil(async () => (await budget.readState()).attempts === 0, { timeoutMs: 3000 });
    expect(isExhausted(budget)).toBe(false);
  });

  it('readState does not count as an attempt', async ({ makeBudget }) => {
    const budget = makeBudget({
      windowMs: 60_000,
      minCalls: 10,
      retryRatio: 0.5,
      keyPrefix: uniquePrefix('rb'),
    });

    budget.recordAttempt(false);
    await waitUntil(async () => (await budget.readState()).attempts === 1);
    await budget.readState();

    await expect(budget.readState()).resolves.toEqual({ attempts: 1, retryRatio: 0 });
  });

  it('expires the key after twice the window', async ({ makeBudget, redis }) => {
    const keyPrefix = uniquePrefix('rb');
    const budget = makeBudget({ windowMs: 5_000, minCalls: 1, retryRatio: 1, keyPrefix });

    budget.recordAttempt(false);
    await waitUntil(async () => (await redis.exists(`${keyPrefix}:window`)) === 1);

    const ttl = await redis.pttl(`${keyPrefix}:window`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  it('prunes aged out buckets when it records', async ({ makeBudget, redis }) => {
    const keyPrefix = uniquePrefix('rb');
    const budget = makeBudget({ windowMs: 200, minCalls: 1, retryRatio: 1, keyPrefix });

    budget.recordAttempt(true);
    await waitUntil(async () => (await redis.hlen(`${keyPrefix}:window`)) === 2);

    await new Promise((resolve) => setTimeout(resolve, 300));
    budget.recordAttempt(false);

    await waitUntil(async () => (await redis.hkeys(`${keyPrefix}:window`)).length === 1);
    expect((await redis.hkeys(`${keyPrefix}:window`))[0]).toMatch(/^wt:/);
  });

  it('fails open while Redis rejects: attempts are logged and the window ages out', async ({
    makeBudget,
    redis,
  }) => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const keyPrefix = uniquePrefix('rb');
    const budget = makeBudget({ windowMs: 300, minCalls: 1, retryRatio: 0.5, keyPrefix, logger });
    const scripts = spyOnScripts(redis);
    scripts.mockRejectedValue(new Error('Redis is down'));

    budget.recordAttempt(true);
    // Counted locally at once, so a burst in this process is still capped.
    expect(isExhausted(budget)).toBe(true);
    await waitUntil(() => logger.error.mock.calls.length === 1);
    expect(logger.error).toHaveBeenCalledWith(
      `[VernLLM] redisRetryBudget: recordAttempt failed for key "${keyPrefix}:window"`,
      expect.objectContaining({ message: 'Redis is down', key: `${keyPrefix}:window` }),
    );

    await expect(budget.readState()).rejects.toMatchObject({
      type: 'network',
      code: 'connection_failed',
    });

    // No reply has landed for longer than the window: the budget lets retries through.
    await waitUntil(() => !isExhausted(budget), { timeoutMs: 2000 });
    scripts.restore();
  });

  it('stops talking to Redis once disposed', async ({ makeBudget, redis }) => {
    const budget = makeBudget({
      windowMs: 60_000,
      minCalls: 1,
      retryRatio: 1,
      keyPrefix: uniquePrefix('rb'),
    });
    const scripts = spyOnScripts(redis);

    budget.dispose();
    budget.dispose();
    budget.recordAttempt(true);

    expect(scripts).not.toHaveBeenCalled();
    expect(budget.getSnapshot()).toEqual({ attempts: 0, retryRatio: 0 });
    scripts.restore();
  });

  it('never shares a hash with a circuit breaker on the same prefix', async ({
    makeBudget,
    makeBreaker,
    redis,
  }) => {
    const keyPrefix = uniquePrefix('shared');
    const budget = makeBudget({ windowMs: 60_000, minCalls: 1, retryRatio: 1, keyPrefix });
    const breaker = makeBreaker({
      keyPrefix,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 100, failureRatio: 1 },
    });

    budget.recordAttempt(true);
    breaker.recordFailure(undefined);
    await waitUntil(async () => (await redis.exists(keyPrefix, `${keyPrefix}:window`)) === 2);

    // Each adapter's rolling window counts only its own traffic.
    await expect(budget.readState()).resolves.toEqual({ attempts: 1, retryRatio: 1 });
    expect(await redis.hkeys(`${keyPrefix}:window`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^wt:/), expect.stringMatching(/^wr:/)]),
    );
    expect(await redis.hkeys(`${keyPrefix}:window`)).toHaveLength(2);
  });
});
