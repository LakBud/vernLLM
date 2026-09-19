import { describe, expect, it, vi } from 'vitest';

import { buildCircuitBreaker } from '../../src/internal/utils/circuit-breaker/circuitBreakerAdapter.utils.js';
import { buildRateLimit } from '../../src/internal/utils/rate-limit/rateLimitAdapter.utils.js';
import { LLMError } from '../../src/types/errors.js';

import type { Logger } from '../../src/logger.js';

const logger = (): Logger => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

function build(adapter: object) {
  return buildCircuitBreaker(
    adapter as never,
    'openai',
    'gpt',
    undefined,
    logger(),
    [],
    5000,
    false,
    true,
  );
}

const breaker = {
  assertClosed: () => {},
  recordSuccess: () => {},
  recordFailure: () => {},
  onStateChange: () => {},
};

const limiter = {
  estimate: () => 0,
  acquire: async () => ({ release: () => {}, waitedMs: 0 }),
  signalRateLimit: () => {},
  reactToRateLimitHint: () => {},
};

describe('circuit breaker adapter: prepare, prepareTimeoutMs and readState validation', () => {
  it.each(['prepare', 'readState'])('rejects a non function %s', (name) => {
    expect(() => build({ ...breaker, [name]: 'nope' })).toThrow(
      new RegExp(`${name}.*must be a function`),
    );
  });

  it.each([0, -5, Number.NaN, Infinity, '500'])('rejects prepareTimeoutMs %s', (value) => {
    expect(() => build({ ...breaker, prepare: async () => {}, prepareTimeoutMs: value })).toThrow(
      /prepareTimeoutMs.*greater than 0/,
    );
  });

  it('reports it as invalid_params', () => {
    expect(() => build({ ...breaker, prepareTimeoutMs: 0 })).toThrow(LLMError);
  });

  it('accepts a complete adapter with all three, and hands it back untouched', () => {
    const adapter = {
      ...breaker,
      prepare: async () => {},
      prepareTimeoutMs: 250,
      readState: async () => 'closed' as const,
    };

    expect(build(adapter)).toBe(adapter);
  });

  it('accepts an adapter that declares prepare but no timeout', () => {
    expect(() => build({ ...breaker, prepare: async () => {} })).not.toThrow();
  });
});

describe('rate limiter adapter: readState validation', () => {
  it('rejects a non function readState', () => {
    expect(() => buildRateLimit({ ...limiter, readState: 'nope' } as never)).toThrow(
      /readState.*must be a function/,
    );
  });

  it('names every invalid optional member at once', () => {
    expect(() => buildRateLimit({ ...limiter, getState: {}, readState: 1 } as never)).toThrow(
      /getState \(object\), readState \(number\) must be a function\. They are optional/,
    );
  });

  it('accepts a real adapter with readState, and hands it back', () => {
    const adapter = { ...limiter, readState: async () => ({}) };

    expect(buildRateLimit(adapter as never)).toBe(adapter);
  });
});
