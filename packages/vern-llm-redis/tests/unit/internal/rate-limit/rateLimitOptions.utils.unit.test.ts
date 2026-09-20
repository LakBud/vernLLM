import { describe, expect, it, vi } from 'vitest';

import { resolveRateLimitOptions } from '../../../../src/internal/rate-limit/rateLimitOptions.utils.js';

describe('resolveRateLimitOptions defaults', () => {
  it('fills every default', () => {
    const resolved = resolveRateLimitOptions({});

    expect(resolved).toMatchObject({
      keyPrefix: 'vernllm:rl',
      wakeChannel: 'vernllm:rl:wake',
      queueKey: 'vernllm:rl:queue',
      maxQueueMs: 30_000,
      maxQueueSize: 0,
      pollIntervalMs: 250,
      concurrencyLeaseMs: 30_000,
      queueLeaseMs: 15_000,
      fairQueue: true,
      estimateFraction: 1,
      aimd: undefined,
    });
    expect(typeof resolved.estimateTokens).toBe('function');
  });

  it('derives the wake channel and queue key from a custom prefix', () => {
    const resolved = resolveRateLimitOptions({ keyPrefix: 'app:rl' });

    expect(resolved.wakeChannel).toBe('app:rl:wake');
    expect(resolved.queueKey).toBe('app:rl:queue');
  });

  it('keeps fairQueue false when explicitly turned off', () => {
    expect(resolveRateLimitOptions({ fairQueue: false }).fairQueue).toBe(false);
  });

  it('uses a custom token estimator', () => {
    const estimateTokens = vi.fn(() => 7);
    expect(resolveRateLimitOptions({ estimateTokens }).estimateTokens).toBe(estimateTokens);
  });

  it('keeps 0 for the options where it means unlimited or wait forever', () => {
    const resolved = resolveRateLimitOptions({
      requestsPerMinute: 0,
      tokensPerMinute: 0,
      maxConcurrent: 0,
      maxQueueMs: 0,
      maxQueueSize: 0,
    });

    expect(resolved.maxQueueMs).toBe(0);
    expect(resolved.maxQueueSize).toBe(0);
  });

  it('passes a valid aimd config through', () => {
    const aimd = { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 };
    expect(resolveRateLimitOptions({ requestsPerMinute: 10, aimd }).aimd).toBe(aimd);
  });
});

describe('resolveRateLimitOptions estimateFraction', () => {
  it('clamps a value above 1 to 1', () => {
    expect(resolveRateLimitOptions({ estimateFraction: 4 }).estimateFraction).toBe(1);
  });

  it('keeps a value between 0 and 1', () => {
    expect(resolveRateLimitOptions({ estimateFraction: 0.25 }).estimateFraction).toBe(0.25);
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects %s', (estimateFraction) => {
    expect(() => resolveRateLimitOptions({ estimateFraction })).toThrow(
      expect.objectContaining({
        type: 'invalid_params',
        message: `estimateFraction (${estimateFraction}) must be a finite number greater than 0.`,
      }),
    );
  });
});

describe('resolveRateLimitOptions validation', () => {
  it.each([
    [
      { requestsPerMinute: -1 },
      'requestsPerMinute must be a finite number that is not negative (got -1).',
    ],
    [
      { tokensPerMinute: Infinity },
      'tokensPerMinute must be a finite number that is not negative (got Infinity).',
    ],
    [
      { maxConcurrent: Number.NaN },
      'maxConcurrent must be a finite number that is not negative (got NaN).',
    ],
    [{ maxQueueMs: -5 }, 'maxQueueMs must be a finite number that is not negative (got -5).'],
    [{ maxQueueSize: 1.5 }, 'maxQueueSize must be a non-negative integer (got 1.5).'],
    [{ maxQueueSize: -1 }, 'maxQueueSize must be a non-negative integer (got -1).'],
    [{ queueLeaseMs: 0 }, 'queueLeaseMs must be a finite number greater than 0 (got 0).'],
    [
      { concurrencyLeaseMs: -1 },
      'concurrencyLeaseMs must be a finite number greater than 0 (got -1).',
    ],
    [{ pollIntervalMs: 0 }, 'pollIntervalMs must be a finite number greater than 0 (got 0).'],
  ])('rejects %j as invalid_params', (options, message) => {
    expect(() => resolveRateLimitOptions(options)).toThrow(
      expect.objectContaining({ type: 'invalid_params', message }),
    );
  });

  it('rejects aimd without requestsPerMinute', () => {
    const aimd = { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 };
    expect(() => resolveRateLimitOptions({ aimd })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });
});
