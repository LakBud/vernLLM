import { describe, expect, it, vi } from 'vitest';

import { RetryBudget, type RetryBudgetAdapter } from '../../../../../src/internal/retryBudget.js';
import { NoopLogger } from '../../../../../src/internal/utils/logger.utils.js';
import { buildRetryBudget } from '../../../../../src/internal/utils/retry-budget/retryBudgetAdapter.utils.js';
import { LLMError } from '../../../../../src/types/errors.js';

const options = { windowMs: 60_000, minCalls: 10, retryRatio: 0.5 };

function adapter(overrides: Partial<RetryBudgetAdapter> = {}): RetryBudgetAdapter {
  return { assertAvailable: () => {}, recordAttempt: () => {}, ...overrides };
}

describe('buildRetryBudget', () => {
  it('returns undefined when the option is omitted', () => {
    expect(buildRetryBudget(undefined)).toBeUndefined();
  });

  it('builds a RetryBudget from plain options', () => {
    expect(buildRetryBudget(options)).toBeInstanceOf(RetryBudget);
  });

  it('still validates plain options, throwing RangeError as the class does', () => {
    expect(() => buildRetryBudget({ ...options, retryRatio: 2 })).toThrow(RangeError);
  });

  it('passes a hand built adapter through untouched', () => {
    const custom = adapter();

    expect(buildRetryBudget(custom)).toBe(custom);
  });

  it('passes a RetryBudget instance through as is', () => {
    const custom = new RetryBudget(options);

    expect(buildRetryBudget(custom)).toBe(custom);
  });

  it('hands the logger to setLogger once', () => {
    const setLogger = vi.fn();
    const logger = new NoopLogger();

    buildRetryBudget(adapter({ setLogger }), logger);

    expect(setLogger).toHaveBeenCalledOnce();
    expect(setLogger).toHaveBeenCalledWith(logger);
  });

  it('skips setLogger when no logger is given', () => {
    const setLogger = vi.fn();

    buildRetryBudget(adapter({ setLogger }));

    expect(setLogger).not.toHaveBeenCalled();
  });

  it('throws invalid_params for a half built adapter, naming what is missing', () => {
    const halfBuilt = { assertAvailable: () => {} } as unknown as RetryBudgetAdapter;

    expect(() => buildRetryBudget(halfBuilt)).toThrow(LLMError);
    expect(() => buildRetryBudget(halfBuilt)).toThrow(
      'retryBudget looks like a RetryBudgetAdapter but is missing: recordAttempt. Both assertAvailable and recordAttempt are required.',
    );
  });

  it('throws invalid_params for one optional member that is not a function', () => {
    const bad = adapter({ readState: 'nope' as unknown as RetryBudgetAdapter['readState'] });

    expect(() => buildRetryBudget(bad)).toThrow(
      "retryBudget's readState (string) must be a function. It is optional; omit entirely rather than assigning a non-function value.",
    );
  });

  it('names every bad optional member at once', () => {
    const bad = adapter({
      getSnapshot: 1 as unknown as RetryBudgetAdapter['getSnapshot'],
      setLogger: {} as unknown as RetryBudgetAdapter['setLogger'],
    });

    expect(() => buildRetryBudget(bad)).toThrow(
      "retryBudget's getSnapshot (number), setLogger (object) must be a function. They are optional;",
    );
  });

  it('reports invalid_params as the error type', () => {
    const halfBuilt = { recordAttempt: () => {} } as unknown as RetryBudgetAdapter;

    expect(() => buildRetryBudget(halfBuilt)).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it.each([null, false])('treats %s as no budget, as before adapters existed', (value) => {
    expect(buildRetryBudget(value as never)).toBeUndefined();
  });
});
