import { describe, expect, it, vi } from 'vitest';

import {
  makeEventReporter,
  reportRejection,
  resolveExecutor,
  warnIfModelUnsupported,
} from '../../../../../src/internal/utils/circuit-breaker/circuitBreaker.utils.js';
import { LLMError } from '../../../../../src/types/errors.js';

import type { CallExecutor } from '../../../../../src/internal/execution/callExecutor.js';
import type { Logger } from '../../../../../src/logger.js';
import type { TokenUsage, VernLLMEvent } from '../../../../../src/types/index.js';

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

function baseUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    requestId: 'req-1',
    model: 'gpt-test',
    ...overrides,
  };
}

// `makeEventReporter` is the one dispatch point every event, including
// `'usage'`/`'usage_failure'`, goes through: it calls `onEvent` (if set),
// then separately calls the matching plain `onUsage`/`onUsageFailure`
// hook (if set) for those two kinds. Neither call knows the other ran,
// and a throwing hook in one never stops the other. See
// `VernLLMOptions.onUsage`'s doc comment and the design note in
// `types/events.ts`: the plain hooks are sugar over this event, not a
// second reporting path.
describe('makeEventReporter, usage/usage_failure dispatch', () => {
  it('is a no-op when neither onEvent nor onUsage/onUsageFailure are set', () => {
    const logger = fakeLogger();
    const report = makeEventReporter(undefined, logger);

    expect(() => report({ kind: 'usage', requestId: 'req-1', usage: baseUsage() })).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('calls onEvent for a usage event like any other event kind', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();
    const report = makeEventReporter(onEvent, logger);
    const event: VernLLMEvent = { kind: 'usage', requestId: 'req-1', usage: baseUsage() };

    report(event);

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('calls onUsage with just the usage, separately from onEvent', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();
    const onUsage = vi.fn();
    const report = makeEventReporter(onEvent, logger, { onUsage });
    const usage = baseUsage();

    report({ kind: 'usage', requestId: usage.requestId, usage });

    expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('calls onUsageFailure with the usage and error, separately from onEvent', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();
    const onUsageFailure = vi.fn();
    const report = makeEventReporter(onEvent, logger, { onUsageFailure });
    const usage = baseUsage();
    const error = new LLMError('boom', 'api');

    report({ kind: 'usage_failure', requestId: usage.requestId, usage, error });

    expect(onUsageFailure).toHaveBeenCalledExactlyOnceWith(usage, error);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('never calls onUsage for a usage_failure event, or onUsageFailure for a usage event', () => {
    const logger = fakeLogger();
    const usage = baseUsage();

    const onUsageForFailureCase = vi.fn();
    const reportFailureCase = makeEventReporter(undefined, logger, {
      onUsage: onUsageForFailureCase,
    });
    reportFailureCase({
      kind: 'usage_failure',
      requestId: usage.requestId,
      usage,
      error: new LLMError('x', 'api'),
    });
    expect(onUsageForFailureCase).not.toHaveBeenCalled();

    const onUsageFailureForSuccessCase = vi.fn();
    const reportSuccessCase = makeEventReporter(undefined, logger, {
      onUsageFailure: onUsageFailureForSuccessCase,
    });
    reportSuccessCase({ kind: 'usage', requestId: usage.requestId, usage });
    expect(onUsageFailureForSuccessCase).not.toHaveBeenCalled();
  });

  it('ignores onUsage/onUsageFailure entirely for every other event kind', () => {
    const logger = fakeLogger();
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const report = makeEventReporter(undefined, logger, { onUsage, onUsageFailure });

    report({
      kind: 'retry',
      requestId: 'req-1',
      provider: 'openai',
      model: 'gpt-test',
      attempt: 1,
      maxRetries: 3,
      delayMs: 100,
      retryAfterHonored: false,
      error: new LLMError('boom', 'api'),
    });

    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).not.toHaveBeenCalled();
  });

  it('swallows and logs an error thrown by onUsage, without stopping onEvent from running', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();
    const onUsage = vi.fn(() => {
      throw new Error('onUsage boom');
    });
    const report = makeEventReporter(onEvent, logger, { onUsage });
    const usage = baseUsage();

    expect(() => report({ kind: 'usage', requestId: usage.requestId, usage })).not.toThrow();

    expect(onEvent).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onUsage failed', {
      message: 'onUsage boom',
      stack: expect.any(String),
    });
  });

  it('swallows and logs an error thrown by onUsageFailure, without stopping onEvent from running', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();
    const onUsageFailure = vi.fn(() => {
      throw 'not an Error instance';
    });
    const report = makeEventReporter(onEvent, logger, { onUsageFailure });
    const usage = baseUsage();
    const error = new LLMError('boom', 'api');

    expect(() =>
      report({ kind: 'usage_failure', requestId: usage.requestId, usage, error }),
    ).not.toThrow();

    expect(onEvent).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onUsageFailure failed', {
      message: 'unknown',
    });
  });

  it('still calls onUsage even when onEvent itself throws', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn(() => {
      throw new Error('onEvent boom');
    });
    const onUsage = vi.fn();
    const report = makeEventReporter(onEvent, logger, { onUsage });
    const usage = baseUsage();

    expect(() => report({ kind: 'usage', requestId: usage.requestId, usage })).not.toThrow();

    expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage);
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onEvent failed', {
      message: 'onEvent boom',
      stack: expect.any(String),
    });
  });
});

describe('reportRejection', () => {
  /** Runs `fn`, then lets pending microtasks and timers settle, returning any unhandled rejections seen. */
  async function unhandledDuring(fn: () => void): Promise<unknown[]> {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => void seen.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    return seen;
  }

  it('logs the message of a rejected promise', async () => {
    const logger = fakeLogger();

    await unhandledDuring(() =>
      reportRejection(logger, 'x rejected', Promise.reject(new Error('boom'))),
    );

    expect(logger.error).toHaveBeenCalledWith('x rejected', { message: 'boom' });
  });

  it('ignores a result that is not a promise', async () => {
    const logger = fakeLogger();

    const seen = await unhandledDuring(() => reportRejection(logger, 'x rejected', undefined));

    expect(seen).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not raise a second rejection when the reason cannot be turned into a string', async () => {
    const logger = fakeLogger();

    const seen = await unhandledDuring(() =>
      reportRejection(logger, 'x rejected', Promise.reject(Object.create(null))),
    );

    expect(seen).toEqual([]);
  });
});
