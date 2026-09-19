import { describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../helpers.js';

import type { CircuitBreakerAdapter } from '../../src/circuitBreaker.js';
import type { RateLimiterAdapter } from '../../src/rateLimit.js';

function breaker(overrides: Partial<CircuitBreakerAdapter> = {}): CircuitBreakerAdapter {
  return {
    assertClosed: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    onStateChange: () => {},
    ...overrides,
  };
}

function limiter(overrides: Partial<RateLimiterAdapter> = {}): RateLimiterAdapter {
  return {
    estimate: () => 1,
    acquire: async () => ({ release: () => {}, waitedMs: 0 }),
    signalRateLimit: () => {},
    reactToRateLimitHint: () => {},
    ...overrides,
  };
}

const client = () => createMockClient([jsonResponse({ ok: true })]).client;

describe('VernLLM.readCircuitStates', () => {
  it('asks each breaker for its live state, and prefers readState over getState', async () => {
    const readState = vi.fn(async () => 'open' as const);
    const getState = vi.fn(() => 'closed' as const);
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      circuitBreaker: breaker({ readState, getState }),
    });

    const states = await llm.readCircuitStates();

    expect(states).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'open' },
    ]);
    expect(readState).toHaveBeenCalledWith('m');
    expect(getState).not.toHaveBeenCalled();
  });

  it('falls back to getState for a breaker with no readState', async () => {
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      circuitBreaker: breaker({ getState: () => 'half-open' }),
    });

    expect((await llm.readCircuitStates())[0]?.state).toBe('half-open');
  });

  it('reports undefined for a target with no breaker, and covers every target in chain order', async () => {
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      circuitBreaker: breaker({ readState: async () => 'open' }),
      fallback: { client: client(), model: 'fb' },
    });

    const states = await llm.readCircuitStates('custom');

    expect(states.map((s) => [s.index, s.isFallback, s.state])).toEqual([
      [0, false, 'open'],
      [1, true, undefined],
    ]);
  });

  it('passes an explicit model through to readState', async () => {
    const readState = vi.fn(async () => 'closed' as const);
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      circuitBreaker: breaker({ readState, isolateByModel: true }),
    });

    await llm.readCircuitStates('other-model');

    expect(readState).toHaveBeenCalledWith('other-model');
  });

  it('rejects when the live read itself fails, since a live answer was asked for', async () => {
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      circuitBreaker: breaker({
        readState: async () => {
          throw new Error('redis down');
        },
      }),
    });

    await expect(llm.readCircuitStates()).rejects.toThrow('redis down');
  });
});

describe('VernLLM.readRateLimitState', () => {
  it('asks the limiter for its live levels, and prefers readState over getState', async () => {
    const readState = vi.fn(async () => ({ requestsRemaining: 7 }));
    const getState = vi.fn(() => ({ requestsRemaining: 99 }));
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      rateLimit: limiter({ readState, getState }),
    });

    await expect(llm.readRateLimitState()).resolves.toEqual({ requestsRemaining: 7 });
    expect(getState).not.toHaveBeenCalled();
  });

  it('falls back to getState for a limiter with no readState', async () => {
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      rateLimit: limiter({ getState: () => ({ concurrentInFlight: 2 }) }),
    });

    await expect(llm.readRateLimitState()).resolves.toEqual({ concurrentInFlight: 2 });
  });

  it('is undefined for a target with no limiter, or a limiter that reports nothing', async () => {
    const none = new VernLLM({ client: client(), model: 'm' });
    const silent = new VernLLM({ client: client(), model: 'm', rateLimit: limiter() });

    await expect(none.readRateLimitState()).resolves.toBeUndefined();
    await expect(silent.readRateLimitState()).resolves.toBeUndefined();
  });

  it('reads a fallback target by index, and rejects an index that names no target', async () => {
    const llm = new VernLLM({
      client: client(),
      model: 'm',
      fallback: {
        client: client(),
        model: 'fb',
        rateLimit: limiter({ readState: async () => ({ tokensRemaining: 5 }) }),
      },
    });

    await expect(llm.readRateLimitState({ index: 1 })).resolves.toEqual({ tokensRemaining: 5 });
    await expect(llm.readRateLimitState({ index: 9 })).rejects.toThrow(RangeError);
  });
});
