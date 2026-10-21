import { windowFor } from './windows.utils.js';

import type { ResolvedBudget, Scope } from '../../types/index.js';

export type Scalar = string | number | boolean;

export function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export interface BudgetMatch {
  budget: ResolvedBudget;
  /** Position in the configured budgets, so two budgets on one key stay apart. */
  index: number;
  value: Scalar;
}

/**
 * The budgets a `context` falls under: each whose key it carries as a string, number or boolean,
 * and whose `equals` matches strictly. A call without the key is not limited by that budget, and
 * an object or null value never matches.
 */
export function matchBudgets(
  budgets: readonly ResolvedBudget[],
  context: Readonly<Record<string, unknown>> | undefined,
): BudgetMatch[] {
  if (!context) return [];

  const matches: BudgetMatch[] = [];
  budgets.forEach((budget, index) => {
    const value = context[budget.key];
    if (!isScalar(value)) return;
    if (budget.equals !== undefined && value !== budget.equals) return;
    matches.push({ budget, index, value });
  });
  return matches;
}

/**
 * The scope for one match. The key joins the budget's position, the value and the window, so a new
 * window counts from zero. Built with `JSON.stringify` so no value can collide with another.
 */
export function scopeOf(
  { budget, index, value }: BudgetMatch,
  nowMs: number,
  timeZone?: string,
): Scope {
  const window = windowFor(budget.per, nowMs, timeZone);
  return {
    key: JSON.stringify([index, budget.key, value, window.id]),
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
