import type { Amount, Scope } from './budgets.js';

type MaybePromise<T> = T | Promise<T>;

/** Where budget spend and reservations live. The default is in memory, per process. */
export interface UsageStore {
  /**
   * Holds `amount` against every scope, or against none: if any scope would go over its limit
   * nothing is held and that scope comes back with what is left of it. `ttlMs` frees a
   * reservation that is never settled.
   */
  reserve(
    scopes: readonly Scope[],
    amount: Amount,
    ttlMs: number,
  ): MaybePromise<{ ok: true; id: string } | { ok: false; scope: Scope; remaining: number }>;

  /** Replaces the held estimate with what the call really spent. */
  commit(id: string, actual: Amount): MaybePromise<void>;

  /** Frees a reservation without recording any spend. */
  release(id: string): MaybePromise<void>;

  /** What a scope has spent and has held for calls in flight. Zeros for a scope never used. */
  read(scope: Scope): MaybePromise<{ spent: Amount; reserved: Amount }>;
}
