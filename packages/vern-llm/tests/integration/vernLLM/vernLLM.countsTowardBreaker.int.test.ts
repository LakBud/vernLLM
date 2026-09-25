import { describe, expect, it } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, jsonResponse } from '../../helpers.js';

import type { RateLimiterAdapter } from '../../../src/rateLimit.js';

/**
 * `quota_exceeded` is retryable but should no longer count toward the
 * circuit breaker, while a real provider failure (`server_error`) still
 * does, at the same threshold. This is exercised as a real call through
 * `VernLLM`, not just at the `LLMError` unit level, since it's the seam
 * every breaker decision downstream depends on.
 */
describe('countsTowardBreaker end to end', () => {
  it('a target repeatedly rejected with quota_exceeded does not open its circuit', async () => {
    const { client } = createMockClient([
      jsonResponse({ answer: 'unused, reserveUsage throws first' }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        llm.call({
          userContent: 'hello',
          reserveUsage: async () => {
            throw new Error('over quota');
          },
        }),
      ).rejects.toMatchObject({ type: 'quota_exceeded' });
    }

    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('a target repeatedly rejected with a real server_error still opens its circuit at the same threshold', async () => {
    const { client } = createMockClient([
      new FakeApiError('down', 500),
      new FakeApiError('down', 500),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
    });

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({ type: 'api' });
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({ type: 'api' });
    expect(llm.getCircuitStates()[0]?.state).toBe('open');
  });

  it('a successful call still works normally alongside a configured breaker and reserveUsage', async () => {
    const { client } = createMockClient([jsonResponse({ answer: 'ok' })]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
    });

    const result = await llm.call({ userContent: 'hello' });
    expect(result).toBeDefined();
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('a limiter whose backing store is down never opens the provider circuit', async () => {
    const { client, create } = createMockClient([jsonResponse({ answer: 'unused' })]);

    const unreachable: RateLimiterAdapter = {
      estimate: () => 1,
      acquire: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
      signalRateLimit: () => {},
      reactToRateLimitHint: () => {},
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      baseDelayMs: 1,
      rateLimit: unreachable,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
    });

    for (let i = 0; i < 4; i++) {
      await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'connect ECONNREFUSED 127.0.0.1:6379' }),
      });
    }

    expect(create).not.toHaveBeenCalled();
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('a limiter failure on a retry still leaves the breaker alone after a provider failure', async () => {
    const { client } = createMockClient([new FakeApiError('down', 503)]);
    let calls = 0;

    const flaky: RateLimiterAdapter = {
      estimate: () => 1,
      acquire: async () => {
        calls += 1;
        if (calls > 1) throw new Error('redis gone');
        return { release: () => {}, waitedMs: 0 };
      },
      signalRateLimit: () => {},
      reactToRateLimitHint: () => {},
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      rateLimit: flaky,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'redis gone' }),
    });
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });
});
