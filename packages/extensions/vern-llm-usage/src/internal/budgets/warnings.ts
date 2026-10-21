import { isThenable, type MaybePromise } from '../maybePromise.utils.js';
import { toPublicAmount } from '../pricing/charge.utils.js';

import type { Amount, Scope, UsageStore } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { PreDispatchContext } from 'vern-llm';

/** Most scopes remembered as warned. Past it, ones from finished windows are forgotten first. */
const DEFAULT_MAX_REMEMBERED = 10_000;

/**
 * Emits `usage.budget_warning` once per scope and window, when spend plus holds reach `warnAt` of
 * the limit. A scope's key includes its window, so the next window warns again.
 */
export class BudgetWarnings {
  /** Scope key to the end of its window. */
  private readonly warned = new Map<string, number>();

  constructor(
    private readonly warnAt: number | undefined,
    private readonly store: UsageStore,
    private readonly guard: Guard,
    private readonly maxRemembered = DEFAULT_MAX_REMEMBERED,
  ) {}

  /** Checks each scope in turn. Returns a promise only when the store's `read` did. */
  check(scopes: readonly Scope[], ctx: PreDispatchContext): MaybePromise<void> {
    const { warnAt } = this;
    if (warnAt === undefined) return;

    const step = (from: number): MaybePromise<void> => {
      for (let i = from; i < scopes.length; i++) {
        const scope = scopes[i]!;
        if (this.warned.has(scope.key)) continue;

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
              (held) => this.evaluate(scope, held, ctx, warnAt),
              (error: unknown) => this.guard.report('warning', error),
            )
            .then(() => step(i + 1));
        }
        this.evaluate(scope, read, ctx, warnAt);
      }
    };
    return step(0);
  }

  private evaluate(
    scope: Scope,
    { spent, reserved }: { spent: Amount; reserved: Amount },
    ctx: PreDispatchContext,
    warnAt: number,
  ): void {
    try {
      const unit = scope.unit === 'usd' ? 'nanoUsd' : 'tokens';
      const used = (spent[unit] + reserved[unit]) / scope.limit;
      if (used < warnAt) return;

      this.remember(scope);
      ctx.emit('usage.budget_warning', {
        v: 1,
        scope: scope.label,
        unit: scope.unit,
        limit: toPublicAmount(scope.unit, scope.limit),
        used: Math.round(used * 10_000) / 10_000,
      });
    } catch (error) {
      this.guard.report('warning', error);
    }
  }

  private remember(scope: Scope): void {
    if (this.warned.size >= this.maxRemembered) {
      const now = Date.now();
      for (const [key, resetsAtMs] of this.warned) {
        if (resetsAtMs <= now) this.warned.delete(key);
      }
      // All still live: stop remembering the oldest rather than grow without bound.
      if (this.warned.size >= this.maxRemembered) {
        this.warned.delete(this.warned.keys().next().value!);
      }
    }
    this.warned.set(scope.key, scope.resetsAtMs);
  }
}
