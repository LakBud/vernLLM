import { describe, expect, it, vi } from 'vitest';

import {
  buildCircuitBreaker,
  resolveExecutor,
  warnIfModelUnsupported,
} from '../../../../src/internal/utils/circuitBreaker.utils.js';

import type { CallExecutor } from '../../../../src/internal/execution/callExecutor.js';
import type { Logger } from '../../../../src/logger.js';

function fakeExecutor(providerName: string): CallExecutor {
  return { providerName } as unknown as CallExecutor;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('resolveExecutor', () => {
  it('returns the executor at the given index', () => {
    const primary = fakeExecutor('primary');
    const fallback = fakeExecutor('fallback');

    expect(resolveExecutor([primary, fallback], 0, 'caller')).toBe(primary);
    expect(resolveExecutor([primary, fallback], 1, 'caller')).toBe(fallback);
  });

  it('throws a RangeError naming the caller when the index has no target', () => {
    const primary = fakeExecutor('primary');

    expect(() => resolveExecutor([primary], 5, 'getCircuitState')).toThrow(RangeError);
    expect(() => resolveExecutor([primary], 5, 'getCircuitState')).toThrow(/getCircuitState/);
  });

  it('pluralizes the target count correctly in the error message', () => {
    const primary = fakeExecutor('primary');

    expect(() => resolveExecutor([primary], 5, 'caller')).toThrow(/1 target\)/);
    expect(() => resolveExecutor([primary, fakeExecutor('b')], 5, 'caller')).toThrow(/2 targets\)/);
  });

  it('throws for a negative index too', () => {
    const primary = fakeExecutor('primary');

    expect(() => resolveExecutor([primary], -1, 'caller')).toThrow(RangeError);
  });
});

describe('warnIfModelUnsupported', () => {
  it('does nothing when model is undefined', () => {
    const logger = fakeLogger();

    warnIfModelUnsupported(false, undefined, 'caller', logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does nothing when the target isolates by model', () => {
    const logger = fakeLogger();

    warnIfModelUnsupported(true, 'gpt-4o', 'caller', logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns, naming the caller and the model, when a model is given but the target does not isolate by model', () => {
    const logger = fakeLogger();

    warnIfModelUnsupported(false, 'gpt-4o', 'openCircuit', logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toContain('openCircuit');
    expect(message).toContain('gpt-4o');
    expect(message).toContain('isolateByModel');
  });
});

describe('buildCircuitBreaker', () => {
  it('returns undefined when circuitBreakerOption is falsy', () => {
    const logger = fakeLogger();

    expect(
      buildCircuitBreaker(undefined, 'openai', 'gpt-4o', undefined, logger, [], 5000, false, true),
    ).toBeUndefined();
    expect(
      buildCircuitBreaker(false, 'openai', 'gpt-4o', undefined, logger, [], 5000, false, true),
    ).toBeUndefined();
  });

  it('reports the state-change event directly (no middleware context) when the breaker is driven without a call context, e.g. manual open()', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    )!;

    // No context passed: exercises the `else reportEvent(event)` branch,
    // not the `emitEvent` middleware-context path.
    breaker.open();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'circuit_state', provider: 'openai', to: 'open' }),
    );
  });

  it('builds an AttemptContext and routes through emitEvent when the breaker is driven with a call context, e.g. assertClosed()', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    )!;

    breaker.open(); // circuit is now open

    // Elapsed cooldown lets assertClosed transition open -> half-open,
    // this time WITH a context, exercising the AttemptContext-building
    // branch instead of the plain reportEvent() one.
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    breaker.assertClosed('gpt-4o', { requestId: 'req-1', state: new Map(), attempt: 2 });

    vi.useRealTimers();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'circuit_state', provider: 'openai', to: 'half-open' }),
    );
  });

  it('falls back to defaultModel in requestedModel when the call context omits a model', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o-default',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    )!;

    breaker.open();

    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    // No model passed here, so `model ?? defaultModel` should resolve to
    // the constructor's defaultModel.
    breaker.assertClosed(undefined, { requestId: 'req-1', state: new Map(), attempt: 1 });

    vi.useRealTimers();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-default', to: 'half-open' }),
    );
  });

  it('swallows and logs an error thrown by onEvent, instead of propagating it', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn(() => {
      throw new Error('onEvent boom');
    });

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    )!;

    expect(() => breaker.open()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onEvent failed', {
      message: 'onEvent boom',
    });
  });

  it('logs "unknown" when onEvent throws a non-Error value', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn(() => {
      throw 'not an Error instance';
    });

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    )!;

    expect(() => breaker.open()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onEvent failed', {
      message: 'unknown',
    });
  });

  it('swallows and logs an error thrown by a caller-supplied onStateChange, instead of propagating it', () => {
    const logger = fakeLogger();
    const userOnStateChange = vi.fn(() => {
      throw new Error('onStateChange boom');
    });

    const breaker = buildCircuitBreaker(
      { onStateChange: userOnStateChange },
      'openai',
      'gpt-4o',
      undefined,
      logger,
      [],
      5000,
      false,
      true,
    )!;

    expect(() => breaker.open()).not.toThrow();
    expect(userOnStateChange).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] circuitBreaker.onStateChange failed', {
      message: 'onStateChange boom',
    });
  });

  it('logs "unknown" when the caller-supplied onStateChange throws a non-Error value', () => {
    const logger = fakeLogger();
    const userOnStateChange = vi.fn(() => {
      throw 'not an Error instance';
    });

    const breaker = buildCircuitBreaker(
      { onStateChange: userOnStateChange },
      'openai',
      'gpt-4o',
      undefined,
      logger,
      [],
      5000,
      false,
      true,
    )!;

    expect(() => breaker.open()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] circuitBreaker.onStateChange failed', {
      message: 'unknown',
    });
  });
});
