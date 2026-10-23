import { LLMError, type PreDispatchContext, type WireCallRequest } from 'vern-llm';

import { isThenable, type MaybePromise } from '../maybePromise.utils.js';
import { toPublicAmount } from '../pricing/charge.utils.js';
import { holdEstimate } from './holdEstimate.utils.js';
import { matchBudgets, scopeOf } from './scopes.utils.js';

import type { BudgetShare } from '../../logFields.js';
import type { Amount, ResolvedConfig, Scope, UsageStore } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { PriceTable } from '../pricing/priceTable.js';

/** A hold on the scopes a call falls under, and the id the store knows it by. */
export interface Reservation {
  id: string;
  scopes: readonly Scope[];
  /** What was held, so an aborted stream can count it as spend. */
  held: Amount;
  /** How full each budget was after this hold. Empty when the store reported no figures. */
  shares: readonly BudgetShare[];
}

/** A limit the store can never reach, so it holds and records a soft scope without refusing it. */
const UNREACHABLE_LIMIT = Number.MAX_SAFE_INTEGER;

/** Frees a reservation that is never settled, such as one held by a process that died. */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

/**
 * Holds an estimate against a call's budgets before it is sent, and settles it with the real spend.
 */
export class BudgetGate {
  constructor(
    private readonly config: Pick<ResolvedConfig, 'budgets' | 'onStoreError' | 'timeZone'>,
    private readonly store: UsageStore,
    private readonly table: PriceTable,
    private readonly guard: Guard,
  ) {}

  /** Whether any budget is configured. */
  get active(): boolean {
    return this.config.budgets.length > 0;
  }

  /** Holds the estimate against every budget the call falls under, or throws `budget_exceeded`. */
  async reserve(
    request: Readonly<WireCallRequest>,
    ctx: PreDispatchContext,
  ): Promise<Reservation | undefined> {
    // A gate failure follows `onStoreError`, like a failing store.
    let scopes: Scope[];
    let matches: ReturnType<typeof matchBudgets>;
    let estimate: Amount;
    try {
      const nowMs = Date.now();
      matches = matchBudgets(this.config.budgets, ctx.context);
      scopes = matches.map((match) => scopeOf(match, nowMs, this.config.timeZone));
      if (scopes.length === 0) return undefined;
      estimate = holdEstimate(request, ctx, this.table, this.guard);
    } catch (error) {
      this.guard.report('reserve', error);
      if (this.config.onStoreError === 'deny') throw this.unavailable(error);
      return undefined;
    }

    let outcome: Awaited<ReturnType<UsageStore['reserve']>>;
    try {
      // The store checks the limit it is given. A soft scope keeps its real limit for warnings.
      const forStore = scopes.map((scope) =>
        scope.mode === 'soft' ? { ...scope, limit: UNREACHABLE_LIMIT } : scope,
      );
      outcome = await this.store.reserve(forStore, estimate, RESERVATION_TTL_MS);
    } catch (error) {
      this.guard.report('reserve', error);
      if (this.config.onStoreError === 'deny') throw this.unavailable(error);
      return undefined;
    }

    if (!outcome.ok) {
      const { scope } = outcome;
      ctx.emit('usage.budget_exceeded', {
        v: 1,
        scope: scope.label,
        unit: scope.unit,
        limit: toPublicAmount(scope.unit, scope.limit),
        remaining: toPublicAmount(scope.unit, outcome.remaining),
        mode: 'hard',
        blocked: true,
      });
      throw new LLMError(`Budget exceeded: ${outcome.scope.label}`, 'quota_exceeded', {
        code: 'budget_exceeded',
      });
    }
    const shares = this.sharesOf(matches, scopes, outcome.used);
    return { id: outcome.id, scopes, held: estimate, shares };
  }

  /** Each budget's share of its real limit, or nothing when the store did not report figures. */
  private sharesOf(
    matches: ReturnType<typeof matchBudgets>,
    scopes: readonly Scope[],
    used: readonly number[] | undefined,
  ): BudgetShare[] {
    if (!used || used.length !== scopes.length) return [];
    const shares: BudgetShare[] = [];
    for (const [index, scope] of scopes.entries()) {
      const amount = used[index];
      if (typeof amount !== 'number' || !Number.isFinite(amount) || scope.limit <= 0) continue;
      shares.push({
        key: (matches[index] as (typeof matches)[number]).budget.key,
        mode: scope.mode,
        share: amount / scope.limit,
      });
    }
    return shares;
  }

  private unavailable(cause: unknown): LLMError {
    return new LLMError('Usage budget store unavailable', 'quota_exceeded', {
      code: 'budget_exceeded',
      cause,
    });
  }

  /** Replaces the held estimate with the real spend. Never throws. */
  settle(reservation: Reservation, actual: Amount): MaybePromise<void> {
    return this.safely('commit', () => this.store.commit(reservation.id, actual));
  }

  /** Frees the held estimate. Never throws. */
  release(reservation: Reservation): MaybePromise<void> {
    return this.safely('release', () => this.store.release(reservation.id));
  }

  private safely(operation: string, run: () => MaybePromise<void>): MaybePromise<void> {
    try {
      const result = run();
      if (isThenable(result)) {
        return Promise.resolve(result).then(undefined, (error: unknown) =>
          this.guard.report(operation, error),
        );
      }
    } catch (error) {
      this.guard.report(operation, error);
    }
  }
}
