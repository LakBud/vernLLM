import { LLMError, type PreDispatchContext, type WireCallRequest } from 'vern-llm';

import { isThenable, type MaybePromise } from '../maybePromise.utils.js';
import { toPublicAmount } from '../pricing/charge.utils.js';
import { holdEstimate } from './holdEstimate.utils.js';
import { scopesFor } from './scopes.utils.js';

import type { Amount, ResolvedConfig, Scope, UsageStore } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { PriceTable } from '../pricing/priceTable.js';

/** A hold on the scopes a call falls under, and the id the store knows it by. */
export interface Reservation {
  id: string;
  scopes: readonly Scope[];
}

/** Frees a reservation that is never settled, such as one held by a process that died. */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

/**
 * The cut off switch: holds an estimate against the call's budgets before it is sent, and settles
 * it with what the call really spent. A failure of the store or of the gate itself is logged and
 * never changes a call, except that `onStoreError: 'deny'` turns a failing store into a rejection.
 */
export class BudgetGate {
  constructor(
    private readonly config: Pick<ResolvedConfig, 'budgets' | 'onStoreError' | 'timeZone'>,
    private readonly store: UsageStore,
    private readonly table: PriceTable,
    private readonly guard: Guard,
  ) {}

  /** Whether any budget is configured. Without one the gate is never entered. */
  get active(): boolean {
    return this.config.budgets.length > 0;
  }

  /**
   * Holds the call's estimate against every budget it falls under. Returns the reservation, or
   * `undefined` when nothing was held: no budget applies, or the store failed and the call is
   * allowed through. Throws `budget_exceeded`, before any provider is contacted, when a budget
   * has no room or the store failed and `onStoreError` is `'deny'`.
   */
  async reserve(
    request: Readonly<WireCallRequest>,
    ctx: PreDispatchContext,
  ): Promise<Reservation | undefined> {
    const scopes = this.guard<Scope[]>(
      'scopes',
      () => scopesFor(this.config.budgets, ctx.context, Date.now(), this.config.timeZone),
      [],
    );
    if (scopes.length === 0) return undefined;

    const estimate = this.guard<Amount>(
      'estimate',
      () => holdEstimate(request, ctx, this.table, this.guard),
      {
        nanoUsd: 0,
        tokens: 0,
      },
    );

    let outcome: Awaited<ReturnType<UsageStore['reserve']>>;
    try {
      outcome = await this.store.reserve(scopes, estimate, RESERVATION_TTL_MS);
    } catch (error) {
      this.guard.report('reserve', error);
      if (this.config.onStoreError === 'deny') {
        throw new LLMError('Usage budget store unavailable', 'quota_exceeded', {
          code: 'budget_exceeded',
          cause: error,
        });
      }
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
      });
      throw new LLMError(`Budget exceeded: ${outcome.scope.label}`, 'quota_exceeded', {
        code: 'budget_exceeded',
      });
    }
    return { id: outcome.id, scopes };
  }

  /**
   * Replaces the held estimate with the real spend. Never throws, and returns a promise only when
   * the store did.
   */
  settle(reservation: Reservation, actual: Amount): MaybePromise<void> {
    return this.safely('commit', () => this.store.commit(reservation.id, actual));
  }

  /**
   * Frees the held estimate when the call spent nothing it knows of. Never throws, and returns a
   * promise only when the store did.
   */
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
