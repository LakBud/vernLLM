import { describe, it, expect } from 'vitest';

import {
  effortToBudgetTokens,
  budgetTokensToEffort,
  resolveEffortTokenTable,
  DEFAULT_EFFORT_TOKENS,
  isAdaptiveOnlyModel,
  supportsManualThinkingBudget,
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

    it('rejects an override that puts low above medium', () => {
      expect(() => resolveEffortTokenTable({ low: 20000 })).toThrow(/ascending order/);
    });

    it('rejects an override that puts medium above high', () => {
      expect(() => resolveEffortTokenTable({ medium: 40000 })).toThrow(/ascending order/);
    });

    it('rejects an override that puts minimal above low', () => {
      expect(() => resolveEffortTokenTable({ minimal: 5000 })).toThrow(/ascending order/);
    });

    it('rejects two tiers set to the same value, ascending order must be strict', () => {
      expect(() => resolveEffortTokenTable({ medium: 32000, high: 32000 })).toThrow(
        /ascending order/,
      );
    });

    it('does not mutate DEFAULT_EFFORT_TOKENS when building an override', () => {
      resolveEffortTokenTable({ high: 99999 });

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
      // low: 8000 keeps ascending order (1024 < 8000 < 16000 < 32000)
      // while still raising the threshold above the built-in 4096, so a
      // value that would default-bucket into "medium" now buckets into
      // "low" against the overridden table instead.
      const table = resolveEffortTokenTable({ low: 8000 });

      expect(budgetTokensToEffort(8000, table)).toBe('low');
      expect(budgetTokensToEffort(8000)).toBe('medium'); // built-in default is unaffected
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

  describe('isAdaptiveOnlyModel / supportsManualThinkingBudget', () => {
    it('treats pre-4.7 Opus models as still supporting manual thinking', () => {
      expect(isAdaptiveOnlyModel('claude-opus-4-6')).toBe(false);
      expect(isAdaptiveOnlyModel('claude-opus-4-5')).toBe(false);
      expect(isAdaptiveOnlyModel('claude-opus-4')).toBe(false);
      expect(supportsManualThinkingBudget('claude-opus-4-6')).toBe(true);
    });

    it('treats Opus 4.7 and 4.8 as adaptive-only, the documented threshold', () => {
      expect(isAdaptiveOnlyModel('claude-opus-4-7')).toBe(true);
      expect(isAdaptiveOnlyModel('claude-opus-4-8')).toBe(true);
      expect(supportsManualThinkingBudget('claude-opus-4-8')).toBe(false);
    });

    it('treats Opus 5 and every future Opus point release as adaptive-only via the version threshold, not a fixed list', () => {
      expect(isAdaptiveOnlyModel('claude-opus-5')).toBe(true);
      // These specific ids were never listed anywhere; the threshold
      // check catches them automatically, which is the entire point of
      // replacing the old flat substring list with a version comparison.
      expect(isAdaptiveOnlyModel('claude-opus-4-9')).toBe(true);
      expect(isAdaptiveOnlyModel('claude-opus-4-20')).toBe(true);
      expect(isAdaptiveOnlyModel('claude-opus-6')).toBe(true);
    });

    it('treats every non-Opus Claude 5 tier model as adaptive-only', () => {
      expect(isAdaptiveOnlyModel('claude-sonnet-5')).toBe(true);
      expect(isAdaptiveOnlyModel('claude-fable-5')).toBe(true);
      expect(isAdaptiveOnlyModel('claude-mythos-5')).toBe(true);
      expect(isAdaptiveOnlyModel('claude-mythos-preview')).toBe(true);
    });

    it('treats unrelated models, including older Sonnet/Haiku generations, as supporting manual thinking', () => {
      expect(isAdaptiveOnlyModel('claude-sonnet-4-6')).toBe(false);
      expect(isAdaptiveOnlyModel('claude-haiku-4-5')).toBe(false);
      expect(isAdaptiveOnlyModel('gpt-4o')).toBe(false);
    });

    it('parses the version threshold correctly inside a Bedrock-prefixed model id', () => {
      expect(isAdaptiveOnlyModel('anthropic.claude-opus-4-7-20260101-v1:0')).toBe(true);
      expect(isAdaptiveOnlyModel('anthropic.claude-opus-4-6-20250115-v1:0')).toBe(false);
      expect(isAdaptiveOnlyModel('anthropic.claude-sonnet-5-20260101-v1:0')).toBe(true);
    });

    it('does not mistake a snapshot-date suffix for a huge minor version', () => {
      // "claude-opus-4-20250514" is the real, still-supported base Opus 4
      // model id, no explicit ".7"-style minor at all, just an 8-digit
      // YYYYMMDD date directly after the major version. Read naively,
      // 20250514 looks like a minor version far past any real threshold
      // and would wrongly classify this pre-4.6 model as adaptive-only.
      expect(isAdaptiveOnlyModel('claude-opus-4-20250514')).toBe(false);
      expect(isAdaptiveOnlyModel('anthropic.claude-opus-4-20250514-v1:0')).toBe(false);
      expect(supportsManualThinkingBudget('claude-opus-4-20250514')).toBe(true);

      // A real, dated 4.7+ release must still be caught correctly, the
      // fix only special-cases the *undated-minor* shape, not every
      // three-segment id.
      expect(isAdaptiveOnlyModel('claude-opus-4-7-20260315')).toBe(true);
      expect(isAdaptiveOnlyModel('anthropic.claude-opus-5-20260724-v1:0')).toBe(true);
    });

    it('lets an array override mark an additional model as adaptive-only', () => {
      expect(isAdaptiveOnlyModel('claude-nova-1')).toBe(false);
      expect(isAdaptiveOnlyModel('claude-nova-1', ['claude-nova-1'])).toBe(true);
      // An unrelated model in the override list has no effect on this one.
      expect(isAdaptiveOnlyModel('claude-nova-1', ['some-other-model'])).toBe(false);
    });

    it('lets a predicate override mark an additional model as adaptive-only', () => {
      const override = (model: string) => model.startsWith('claude-nova');

      expect(isAdaptiveOnlyModel('claude-nova-2', override)).toBe(true);
      expect(isAdaptiveOnlyModel('claude-haiku-4-5', override)).toBe(false);
    });

    it('is additive: an override cannot un-mark a model the built-in rule already caught', () => {
      // An empty override list still leaves the built-in rule in charge.
      expect(isAdaptiveOnlyModel('claude-opus-5', [])).toBe(true);
      // A predicate that always returns false doesn't override the
      // built-in "true" either, only ever adds coverage, never removes it.
      expect(isAdaptiveOnlyModel('claude-opus-5', () => false)).toBe(true);
    });

    it('supportsManualThinkingBudget is exactly the inverse of isAdaptiveOnlyModel, override included', () => {
      expect(supportsManualThinkingBudget('claude-nova-1', ['claude-nova-1'])).toBe(false);
      expect(supportsManualThinkingBudget('claude-opus-4-6', ['claude-opus-4-6'])).toBe(false);
      expect(supportsManualThinkingBudget('claude-opus-4-6')).toBe(true);
    });
  });
});
