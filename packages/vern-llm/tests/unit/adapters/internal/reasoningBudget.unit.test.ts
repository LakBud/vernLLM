import { describe, it, expect } from 'vitest';

import {
  effortToBudgetTokens,
  budgetTokensToEffort,
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
});
