import { isThenable, type MaybePromise } from '../maybePromise.utils.js';
import { toPublicAmount } from '../pricing/charge.utils.js';

import type { Amount, Scope, UsageStore } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { PreDispatchContext } from 'vern-llm';

/** Most scopes remembered as warned. */
const DEFAULT_MAX_REMEMBERED = 10_000;

/** The highest threshold emitted for a scope, and the end of its window. */
interface Warned {
  threshold: number;
  resetsAtMs: number;
}

/**
 * Emits `usage.budget_warning` once per threshold, scope and window when spend plus holds reach it.
 * A call that jumps past several thresholds emits only the highest one. A soft budget adds
 * threshold 1, which emits `usage.budget_exceeded` with `blocked: false` instead.
 */
export class BudgetWarnings {
  private readonly warned = new Map<string, Warned>();
  /** A soft budget also reports crossing its limit, as threshold 1. */
  private readonly softThresholds: readonly number[];

  /** @param thresholds Sorted ascending, as `normalizeWarnAt` returns them. Empty turns warnings off for hard budgets. */
  constructor(
    private readonly thresholds: readonly number[],
    private readonly store: UsageStore,
    private readonly guard: Guard,
    private readonly maxRemembered = DEFAULT_MAX_REMEMBERED,
  ) {
    this.softThresholds = [...thresholds, 1];
  }

  private thresholdsFor(scope: Scope): readonly number[] {
    return scope.mode === 'soft' ? this.softThresholds : this.thresholds;
  }

  /** Checks each scope in turn. */
  check(scopes: readonly Scope[], ctx: PreDispatchContext): MaybePromise<void> {
    const step = (from: number): MaybePromise<void> => {
      for (let i = from; i < scopes.length; i++) {
        const scope = scopes[i]!;
        // Past the top threshold there is nothing left to say, so no more reads.
        const levels = this.thresholdsFor(scope);
        if (levels.length === 0) continue;
        if ((this.warned.get(scope.key)?.threshold ?? 0) >= levels[levels.length - 1]!) continue;

        let read: ReturnType<UsageStore['read']>;
        try {
          read = this.store.read(scope);
        } catch (error) {
          this.guard.report('warning', error);
          continue;
        }

        if (isThenable(read)) {
          return Promise.resolve(read)
            .then(
              (held) => this.evaluate(scope, held, ctx),
              (error: unknown) => this.guard.report('warning', error),
            )
            .then(() => step(i + 1));
        }
        this.evaluate(scope, read, ctx);
      }
    };
    return step(0);
  }

  private evaluate(
    scope: Scope,
    { spent, reserved }: { spent: Amount; reserved: Amount },
    ctx: PreDispatchContext,
  ): void {
    try {
      const unit = scope.unit === 'usd' ? 'nanoUsd' : 'tokens';
      const used = (spent[unit] + reserved[unit]) / scope.limit;
      const threshold = this.highestCrossed(this.thresholdsFor(scope), used);
      // Another call may have warned while the read was in flight.
      if (threshold === undefined || threshold <= (this.warned.get(scope.key)?.threshold ?? 0)) {
        return;
      }

      this.remember(scope, threshold);
      const limit = toPublicAmount(scope.unit, scope.limit);
      if (threshold === 1) {
        // Only a soft budget has threshold 1. The call that crossed it has completed.
        ctx.emit('usage.budget_exceeded', {
          v: 1,
          scope: scope.label,
          unit: scope.unit,
          limit,
          remaining: 0,
          mode: scope.mode,
          blocked: false,
        });
        return;
      }
      ctx.emit('usage.budget_warning', {
        v: 1,
        scope: scope.label,
        unit: scope.unit,
        limit,
        threshold,
        mode: scope.mode,
        used: Math.round(used * 10_000) / 10_000,
      });
    } catch (error) {
      this.guard.report('warning', error);
    }
  }

  private highestCrossed(levels: readonly number[], used: number): number | undefined {
    for (let i = levels.length - 1; i >= 0; i--) {
      if (used >= levels[i]!) return levels[i];
    }
    return undefined;
  }

  private remember(scope: Scope, threshold: number): void {
    if (!this.warned.has(scope.key) && this.warned.size >= this.maxRemembered) {
      const now = Date.now();
      for (const [key, { resetsAtMs }] of this.warned) {
        if (resetsAtMs <= now) this.warned.delete(key);
      }
      // All still live: forget the oldest rather than grow without bound.
      if (this.warned.size >= this.maxRemembered) {
        this.warned.delete(this.warned.keys().next().value!);
      }
    }
    this.warned.set(scope.key, { threshold, resetsAtMs: scope.resetsAtMs });
  }
}
