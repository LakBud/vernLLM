import { windowFor } from './windows.utils.js';

import type { ResolvedBudget, Scope } from '../../types/index.js';

export type Scalar = string | number | boolean;

export function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export interface BudgetMatch {
  budget: ResolvedBudget;
  value: Scalar;
}

/** The budgets a `context` falls under. A missing key, an object or null never matches. */
export function matchBudgets(
  budgets: readonly ResolvedBudget[],
  context: Readonly<Record<string, unknown>> | undefined,
): BudgetMatch[] {
  if (!context) return [];

  const matches: BudgetMatch[] = [];
  for (const budget of budgets) {
    const value = context[budget.key];
    if (!isScalar(value)) continue;
    if (budget.equals !== undefined && value !== budget.equals) continue;
    matches.push({ budget, value });
  }
  return matches;
}

/** The scope for one match, keyed by budget, value and window. */
export function scopeOf({ budget, value }: BudgetMatch, nowMs: number, timeZone?: string): Scope {
  const window = windowFor(budget.per, nowMs, timeZone);
  return {
    key: JSON.stringify([budget.key, budget.equals ?? null, budget.unit, value, window.id]),
    label: `${budget.key}=${String(value)} per ${budget.per}`,
    unit: budget.unit,
    limit: budget.limit,
    resetsAtMs: window.resetsAtMs,
  };
}

/** The scopes one call falls under. */
export function scopesFor(
  budgets: readonly ResolvedBudget[],
  context: Readonly<Record<string, unknown>> | undefined,
  nowMs: number,
  timeZone?: string,
): Scope[] {
  return matchBudgets(budgets, context).map((match) => scopeOf(match, nowMs, timeZone));
}
