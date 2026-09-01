import { describe, it, expect } from 'vitest';

import { RetryBudget } from '../../../src/internal/retryBudget.js';
import { isLLMError } from '../../../src/types/errors.js';

describe('RetryBudget (unit)', () => {
  it('throws for a non positive windowMs, same as RollingRatio', () => {
    expect(() => new RetryBudget({ windowMs: 0, minCalls: 1, retryRatio: 0.5 })).toThrow(
      RangeError,
    );
    expect(() => new RetryBudget({ windowMs: -1, minCalls: 1, retryRatio: 0.5 })).toThrow(
      RangeError,
    );
  });

  it('throws for an invalid minCalls', () => {
    expect(() => new RetryBudget({ windowMs: 60_000, minCalls: -1, retryRatio: 0.5 })).toThrow(
      RangeError,
    );
    expect(() => new RetryBudget({ windowMs: 60_000, minCalls: 1.5, retryRatio: 0.5 })).toThrow(
      RangeError,
    );
  });

  it('throws for an invalid retryRatio', () => {
    expect(() => new RetryBudget({ windowMs: 60_000, minCalls: 1, retryRatio: -0.1 })).toThrow(
      RangeError,
    );
    expect(() => new RetryBudget({ windowMs: 60_000, minCalls: 1, retryRatio: 1.1 })).toThrow(
      RangeError,
    );
    expect(() => new RetryBudget({ windowMs: 60_000, minCalls: 1, retryRatio: NaN })).toThrow(
      RangeError,
    );
  });

  it('accepts the boundary values 0 and 1 for retryRatio, and 0 for minCalls', () => {
    expect(() => new RetryBudget({ windowMs: 60_000, minCalls: 0, retryRatio: 0 })).not.toThrow();
    expect(() => new RetryBudget({ windowMs: 60_000, minCalls: 0, retryRatio: 1 })).not.toThrow();
  });

  it('throws for a non positive windowMs, same as RollingRatio', () => {
    expect(() => new RetryBudget({ windowMs: 0, minCalls: 1, retryRatio: 0.5 })).toThrow(
      RangeError,
    );
    expect(() => new RetryBudget({ windowMs: -1, minCalls: 1, retryRatio: 0.5 })).toThrow(
      RangeError,
    );
  });

  it('reports an empty snapshot before anything is recorded', () => {
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 5, retryRatio: 0.5 });
    expect(budget.getSnapshot()).toEqual({ attempts: 0, retryRatio: 0 });
  });

  it('never trips below minCalls, even at 100% retry ratio', () => {
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 10, retryRatio: 0.5 });

    for (let i = 0; i < 9; i++) budget.recordAttempt(true);

    expect(() => budget.assertAvailable()).not.toThrow();
    expect(budget.getSnapshot()).toEqual({ attempts: 9, retryRatio: 1 });
  });

  it('trips once minCalls and retryRatio are both reached', () => {
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 10, retryRatio: 0.5 });

    for (let i = 0; i < 5; i++) budget.recordAttempt(true);
    for (let i = 0; i < 5; i++) budget.recordAttempt(false);

    expect(() => budget.assertAvailable()).toThrow();

    try {
      budget.assertAvailable();
    } catch (err) {
      expect(isLLMError(err)).toBe(true);
      if (isLLMError(err)) {
        expect(err.code).toBe('retry_budget_exhausted');
        expect(err.type).toBe('rate_limited');
      }
    }
  });

  it('stays under budget when the retry ratio is below retryRatio', () => {
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 10, retryRatio: 0.5 });

    for (let i = 0; i < 2; i++) budget.recordAttempt(true);
    for (let i = 0; i < 8; i++) budget.recordAttempt(false);

    expect(() => budget.assertAvailable()).not.toThrow();
  });
});
