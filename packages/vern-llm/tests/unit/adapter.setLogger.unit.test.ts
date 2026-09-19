import { describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient } from './../helpers.js';

import type { CircuitBreakerAdapter } from '../../src/circuitBreaker.js';
import type { Logger } from '../../src/logger.js';
import type { RateLimiterAdapter } from '../../src/rateLimit.js';

function breakerAdapter(setLogger?: (logger: Logger) => void): CircuitBreakerAdapter {
  return {
    assertClosed: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    onStateChange: () => {},
    setLogger,
  };
}

function limiterAdapter(setLogger?: (logger: Logger) => void): RateLimiterAdapter {
  return {
    estimate: () => 1,
    acquire: async () => ({ release: () => {}, waitedMs: 0 }),
    signalRateLimit: () => {},
    reactToRateLimitHint: () => {},
    setLogger,
  };
}

function customLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

describe('adapter setLogger handoff', () => {
  it('hands a circuit breaker adapter the instance logger', () => {
    const logger = customLogger();
    const setLogger = vi.fn();
    const { client } = createMockClient([]);

    new VernLLM({ client, model: 'm', logger, circuitBreaker: breakerAdapter(setLogger) });

    expect(setLogger).toHaveBeenCalledTimes(1);
    const received = setLogger.mock.calls[0]![0] as Logger;
    received.warn('from adapter');
    expect(logger.warn).toHaveBeenCalledWith('from adapter');
  });

  it('hands a rate limiter adapter the instance logger', () => {
    const logger = customLogger();
    const setLogger = vi.fn();
    const { client } = createMockClient([]);

    new VernLLM({ client, model: 'm', logger, rateLimit: limiterAdapter(setLogger) });

    expect(setLogger).toHaveBeenCalledTimes(1);
    (setLogger.mock.calls[0]![0] as Logger).error('boom', { a: 1 });
    expect(logger.error).toHaveBeenCalledWith('boom', { a: 1 });
  });

  it("logger: 'silent' reaches the adapter as a logger that prints nothing", () => {
    const setLogger = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = createMockClient([]);

    new VernLLM({ client, model: 'm', logger: 'silent', rateLimit: limiterAdapter(setLogger) });
    (setLogger.mock.calls[0]![0] as Logger).error('quiet');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a throwing instance logger cannot break the adapter that logs through it', () => {
    const setLogger = vi.fn();
    const logger: Logger = {
      debug: () => {},
      warn: () => {},
      error: () => {
        throw new Error('sink down');
      },
    };
    const { client } = createMockClient([]);

    new VernLLM({ client, model: 'm', logger, rateLimit: limiterAdapter(setLogger) });

    expect(() => (setLogger.mock.calls[0]![0] as Logger).error('x')).not.toThrow();
  });

  it('adapters without setLogger keep working unchanged', () => {
    const { client } = createMockClient([]);

    expect(
      () =>
        new VernLLM({
          client,
          model: 'm',
          circuitBreaker: breakerAdapter(),
          rateLimit: limiterAdapter(),
        }),
    ).not.toThrow();
  });

  it('rejects a non function setLogger on a circuit breaker adapter', () => {
    const { client } = createMockClient([]);

    expect(
      () =>
        new VernLLM({
          client,
          model: 'm',
          circuitBreaker: breakerAdapter('nope' as never),
        }),
    ).toThrowError(/setLogger/);
  });
});
