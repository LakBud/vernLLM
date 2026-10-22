import { toPublicAmount } from '../pricing/charge.utils.js';
import { matchBudgets, scopeOf } from './scopes.utils.js';

import type {
  AttributionFilter,
  BudgetStatus,
  ResolvedConfig,
  UsageStore,
} from '../../types/index.js';

/** Each budget that applies to a filter, with what is left of it. */
export function createRemaining(
  config: Pick<ResolvedConfig, 'budgets' | 'timeZone'>,
  store: UsageStore,
): (filter: AttributionFilter) => Promise<BudgetStatus[]> {
  return async (filter) => {
    const nowMs = Date.now();
    const statuses: BudgetStatus[] = [];

    for (const match of matchBudgets(config.budgets, filter)) {
      const scope = scopeOf(match, nowMs, config.timeZone);
      const { spent, reserved } = await store.read(scope);
      const unit = scope.unit === 'usd' ? 'nanoUsd' : 'tokens';
      const held = spent[unit] + reserved[unit];

      statuses.push({
        key: match.budget.key,
        value: match.value,
        per: match.budget.per,
        unit: scope.unit,
        limit: toPublicAmount(scope.unit, scope.limit),
        mode: scope.mode,
        spent: toPublicAmount(scope.unit, spent[unit]),
        reserved: toPublicAmount(scope.unit, reserved[unit]),
        remaining: toPublicAmount(scope.unit, Math.max(0, scope.limit - held)),
        overBy: toPublicAmount(scope.unit, Math.max(0, held - scope.limit)),
        resetsAt: new Date(scope.resetsAtMs).toISOString(),
      });
    }
    return statuses;
  };
}
