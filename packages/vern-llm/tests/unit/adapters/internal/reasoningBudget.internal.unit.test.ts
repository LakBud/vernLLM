import { describe, it, expect } from 'vitest';

import {
  effortToBudgetTokens,
  budgetTokensToEffort,
  resolveEffortTokenTable,
  DEFAULT_EFFORT_TOKENS,
} from '../../../../src/adapters/internal/reasoningBudget.utils.js';

describe('reasoningBudget.utils', () => {
  it('maps each effort tier to a fixed token budget', () => {
    expect(effortToBudgetTokens('minimal')).toBe(1024);
    expect(effortToBudgetTokens('low')).toBe(4096);
    expect(effortToBudgetTokens('medium')).toBe(16000);
    expect(effortToBudgetTokens('high')).toBe(32000);
  });

  it('buckets a raw token budget into the nearest effort tier', () => {
    expect(budgetTokensToEffort(1024)).toBe('minimal');
    expect(budgetTokensToEffort(500)).toBe('minimal');
    expect(budgetTokensToEffort(4096)).toBe('low');
    expect(budgetTokensToEffort(2000)).toBe('low');
    expect(budgetTokensToEffort(16000)).toBe('medium');
    expect(budgetTokensToEffort(10000)).toBe('medium');
    expect(budgetTokensToEffort(32000)).toBe('high');
    expect(budgetTokensToEffort(64000)).toBe('high');
  });

  it('agrees with itself at each tier boundary value', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
      const budget = effortToBudgetTokens(effort);
      expect(budgetTokensToEffort(budget)).toBe(effort);
    }
  });

  describe('resolveEffortTokenTable', () => {
    it('returns the built-in defaults unchanged when no override is passed', () => {
      expect(resolveEffortTokenTable()).toEqual(DEFAULT_EFFORT_TOKENS);
      expect(resolveEffortTokenTable(undefined)).toEqual(DEFAULT_EFFORT_TOKENS);
    });

    it('merges a partial override over the defaults, leaving omitted tiers untouched', () => {
      const table = resolveEffortTokenTable({ high: 64000 });

      expect(table).toEqual({ minimal: 1024, low: 4096, medium: 16000, high: 64000 });
    });

    it('accepts an override for every tier at once', () => {
      const table = resolveEffortTokenTable({ minimal: 100, low: 200, medium: 300, high: 400 });

      expect(table).toEqual({ minimal: 100, low: 200, medium: 300, high: 400 });
    });

    it('does not mutate DEFAULT_EFFORT_TOKENS when building an override', () => {
      resolveEffortTokenTable({ high: 999 });

      expect(DEFAULT_EFFORT_TOKENS).toEqual({
        minimal: 1024,
        low: 4096,
        medium: 16000,
        high: 32000,
      });
    });
  });

  describe('custom table passed directly to the conversion functions', () => {
    it('effortToBudgetTokens uses the given table instead of the built-in default', () => {
      const table = resolveEffortTokenTable({ high: 64000 });

      expect(effortToBudgetTokens('high', table)).toBe(64000);
      expect(effortToBudgetTokens('minimal', table)).toBe(1024); // untouched tier
    });

    it('budgetTokensToEffort buckets against the given table instead of the built-in default', () => {
      const table = resolveEffortTokenTable({ low: 20000 });

      // 20000 is above the built-in "low" threshold (4096) but below the
      // overridden one, so it should now land in "low", not its built-in
      // bucket of "high" (20000 > the default "medium" cap of 16000).
      expect(budgetTokensToEffort(20000, table)).toBe('low');
      expect(budgetTokensToEffort(20000)).toBe('high'); // built-in default is unaffected
    });

    it('a fully custom table still agrees with itself at its own boundary values', () => {
      const table = resolveEffortTokenTable({
        minimal: 500,
        low: 2000,
        medium: 8000,
        high: 20000,
      });

      for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
        const budget = effortToBudgetTokens(effort, table);
        expect(budgetTokensToEffort(budget, table)).toBe(effort);
      }
    });
  });
});
