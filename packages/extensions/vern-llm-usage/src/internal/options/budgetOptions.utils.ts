import { DEFAULT_TIME_ZONE, isValidTimeZone } from '../budgets/windows.utils.js';
import { isPlainObject } from './validate.utils.js';

import type { BudgetWindow, ResolvedBudget, UsageStore } from '../../types/index.js';

const WINDOWS: readonly BudgetWindow[] = ['hour', 'day', 'month'];
const NANO_PER_USD = 1e9;

/** `attribute`: the context keys spend is attributed to. Empty when absent. */
export function normalizeAttribute(attribute: unknown): readonly string[] {
  if (attribute === undefined) return [];
  if (!Array.isArray(attribute)) {
    throw new Error('usageMiddleware: attribute must be an array of context keys');
  }

  const keys = new Set<string>();
  for (const key of attribute as unknown[]) {
    if (typeof key !== 'string' || key === '') {
      throw new Error('usageMiddleware: attribute must contain only non-empty strings');
    }
    keys.add(key);
  }
  return [...keys];
}

function toLimit(
  budget: Record<string, unknown>,
  label: string,
): Pick<ResolvedBudget, 'unit' | 'limit'> {
  const { limitUsd, limitTokens } = budget;
  if ((limitUsd === undefined) === (limitTokens === undefined)) {
    throw new Error(`usageMiddleware: ${label} needs exactly one of limitUsd or limitTokens`);
  }

  if (limitUsd !== undefined) {
    if (typeof limitUsd !== 'number' || !Number.isFinite(limitUsd) || limitUsd <= 0) {
      throw new Error(`usageMiddleware: ${label}.limitUsd must be a positive number`);
    }

    // Exact in integer nano dollars up to about $9,000,000.
    const limit = Math.round(limitUsd * NANO_PER_USD);
    if (limit < 1 || !Number.isSafeInteger(limit)) {
      throw new Error(`usageMiddleware: ${label}.limitUsd must be between 0.000000001 and 9000000`);
    }
    return { unit: 'usd', limit };
  }

  if (typeof limitTokens !== 'number' || !Number.isSafeInteger(limitTokens) || limitTokens <= 0) {
    throw new Error(`usageMiddleware: ${label}.limitTokens must be a positive integer`);
  }
  return { unit: 'tokens', limit: limitTokens };
}

/** `budgets`: validated and converted to one limit in its own unit. Empty when absent. */
export function normalizeBudgets(
  budgets: unknown,
  attribute: readonly string[],
): readonly ResolvedBudget[] {
  if (budgets === undefined) return [];
  if (!Array.isArray(budgets)) throw new Error('usageMiddleware: budgets must be an array');

  const seen = new Map<string, number>();

  return (budgets as unknown[]).map((budget, index) => {
    const label = `budgets[${index}]`;
    if (!isPlainObject(budget)) throw new Error(`usageMiddleware: ${label} must be an object`);

    const { key, equals, per } = budget;
    if (typeof key !== 'string' || key === '') {
      throw new Error(`usageMiddleware: ${label}.key must be a non-empty string`);
    }
    if (!attribute.includes(key)) {
      throw new Error(`usageMiddleware: ${label}.key "${key}" must be listed in attribute`);
    }
    if (!WINDOWS.includes(per as BudgetWindow)) {
      throw new Error(`usageMiddleware: ${label}.per must be 'hour', 'day' or 'month'`);
    }
    if (
      equals !== undefined &&
      typeof equals !== 'string' &&
      typeof equals !== 'number' &&
      typeof equals !== 'boolean'
    ) {
      throw new Error(`usageMiddleware: ${label}.equals must be a string, number or boolean`);
    }

    const resolved = { key, equals, per: per as BudgetWindow, ...toLimit(budget, label) };

    // Two such budgets would count the same spend twice.
    const identity = JSON.stringify([key, equals ?? null, resolved.unit, resolved.per]);
    const earlier = seen.get(identity);
    if (earlier !== undefined) {
      throw new Error(
        `usageMiddleware: ${label} repeats budgets[${earlier}]: same key, equals, limit unit and per`,
      );
    }
    seen.set(identity, index);

    return resolved;
  });
}

export function normalizeOnStoreError(value: unknown): 'allow' | 'deny' {
  if (value === undefined) return 'allow';
  if (value !== 'allow' && value !== 'deny') {
    throw new Error("usageMiddleware: onStoreError must be 'allow' or 'deny'");
  }
  return value;
}

export function normalizeStore(store: unknown): UsageStore | undefined {
  if (store === undefined) return undefined;

  const methods = ['reserve', 'commit', 'release', 'read'] as const;
  if (!isPlainObject(store) || methods.some((method) => typeof store[method] !== 'function')) {
    throw new Error('usageMiddleware: store must implement reserve, commit, release and read');
  }
  return store as unknown as UsageStore;
}

/** `warnAt`: a share of the limit, strictly between 0 and 1. Off when absent. */
export function normalizeWarnAt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error('usageMiddleware: warnAt must be a number between 0 and 1, exclusive');
  }
  return value;
}

/** `maxSeries`: a whole number of at least 1. */
export function normalizeMaxSeries(value: unknown): number {
  if (value === undefined) return 1_000;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('usageMiddleware: maxSeries must be a positive integer');
  }
  return value;
}

/** `timeZone`: an IANA zone name this runtime knows. Defaults to UTC. */
export function normalizeTimeZone(value: unknown): string {
  if (value === undefined) return DEFAULT_TIME_ZONE;
  if (typeof value !== 'string' || !isValidTimeZone(value)) {
    throw new Error('usageMiddleware: timeZone must be an IANA time zone such as "Europe/Paris"');
  }
  return value;
}
