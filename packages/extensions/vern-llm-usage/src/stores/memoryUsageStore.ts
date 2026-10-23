import type { Amount, Scope, UsageStore } from '../types/index.js';

export interface MemoryUsageStoreOptions {
  /** Most scope windows tracked at once. Past it a new scope is not limited, with one warning. Defaults to 10,000. */
  maxScopes?: number;
  /** Receives the one warning when `maxScopes` is hit. */
  onWarning?: (message: string) => void;
  /**
   * Throws from `reserve` when `maxScopes` would be exceeded, instead of leaving the new scopes
   * unlimited. `usageMiddleware` turns it on for its default store when `onStoreError` is `'deny'`.
   */
  failClosed?: boolean;
}

const DEFAULT_MAX_SCOPES = 10_000;

/**
 * How long the scopes of an expired hold are remembered, so a call that outlived its hold still
 * records what it spent when it settles. Past it the spend has nowhere to go.
 */
const EXPIRED_RETENTION_MS = 60 * 60 * 1000;

interface Entry {
  spent: Amount;
  reserved: Amount;
  resetsAtMs: number;
}

interface Reservation {
  /** The scopes this reservation is actually held against, not those past `maxScopes`. */
  scopes: readonly Scope[];
  amount: Amount;
  expiresAtMs: number;
}

const zero = (): Amount => ({ nanoUsd: 0, tokens: 0 });
const copy = (amount: Amount): Amount => ({ nanoUsd: amount.nanoUsd, tokens: amount.tokens });
const unitOf = (amount: Amount, unit: Scope['unit']): number =>
  unit === 'usd' ? amount.nanoUsd : amount.tokens;

/**
 * A `UsageStore` in this process's memory. Node runs it on one thread, so `reserve` is atomic
 * without locks. Spend is lost on restart and not shared between processes: use a shared store when
 * several processes must agree on one budget.
 *
 * A call that outlives its reservation's `ttlMs` stops holding room, but its spend is still
 * recorded when it settles, for up to an hour after the hold expired.
 */
export function memoryUsageStore(options: MemoryUsageStoreOptions = {}): UsageStore {
  const maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
  const entries = new Map<string, Entry>();
  const reservations = new Map<string, Reservation>();
  /** Expired holds by id, with when to forget them. Insertion order is forgetting order. */
  const expired = new Map<string, { scopes: readonly Scope[]; forgetAtMs: number }>();
  let nextId = 0;
  let nextSweepAtMs = Number.POSITIVE_INFINITY;
  let warned = false;

  /** Subtracts a reservation's held amount from every scope it was held against. */
  const unhold = (reservation: Reservation): void => {
    for (const scope of reservation.scopes) {
      const entry = entries.get(scope.key);
      if (!entry) continue;
      entry.reserved.nanoUsd = Math.max(0, entry.reserved.nanoUsd - reservation.amount.nanoUsd);
      entry.reserved.tokens = Math.max(0, entry.reserved.tokens - reservation.amount.tokens);
    }
  };

  /**
   * Frees reservations never settled, and forgets old expired ones. Insertion order is expiry order
   * while `ttlMs` is the same for every call, which it is, so the first live one ends the scan.
   */
  const expire = (nowMs: number): void => {
    for (const [id, reservation] of reservations) {
      if (reservation.expiresAtMs > nowMs) break;
      reservations.delete(id);
      unhold(reservation);
      expired.set(id, {
        scopes: reservation.scopes,
        forgetAtMs: reservation.expiresAtMs + EXPIRED_RETENTION_MS,
      });
    }
    for (const [id, entry] of expired) {
      if (entry.forgetAtMs > nowMs) break;
      expired.delete(id);
    }
  };

  /** Adds a call's real spend to the scopes it was held against. */
  const spend = (scopes: readonly Scope[], actual: Amount): void => {
    for (const scope of scopes) {
      const entry = entries.get(scope.key);
      if (!entry) continue;
      entry.spent.nanoUsd += actual.nanoUsd;
      entry.spent.tokens += actual.tokens;
    }
  };

  /** Drops finished windows with nothing in flight, at most once per window boundary. */
  const sweep = (nowMs: number): void => {
    if (nowMs < nextSweepAtMs) return;

    nextSweepAtMs = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      const idle = entry.reserved.nanoUsd === 0 && entry.reserved.tokens === 0;
      if (entry.resetsAtMs <= nowMs && idle) entries.delete(key);
      else nextSweepAtMs = Math.min(nextSweepAtMs, entry.resetsAtMs);
    }
  };

  return {
    reserve(scopes, amount, ttlMs) {
      const nowMs = Date.now();
      expire(nowMs);

      // Past the cap a new scope would go unlimited, or fail the call when `failClosed`. Decided
      // before anything is held, so a throw holds nothing.
      const missing = scopes.filter((scope) => !entries.has(scope.key)).length;
      if (missing > 0) {
        sweep(nowMs);
        if (options.failClosed && entries.size + missing > maxScopes) {
          throw new Error(`memoryUsageStore reached maxScopes (${maxScopes})`);
        }
      }

      // Check every scope before touching any, so a refusal holds nothing anywhere.
      for (const scope of scopes) {
        const entry = entries.get(scope.key);
        const used = entry
          ? unitOf(entry.spent, scope.unit) + unitOf(entry.reserved, scope.unit)
          : 0;
        if (used + unitOf(amount, scope.unit) > scope.limit) {
          return { ok: false, scope, remaining: Math.max(0, scope.limit - used) };
        }
      }

      const held: Scope[] = [];
      const used: number[] = [];
      for (const scope of scopes) {
        let entry = entries.get(scope.key);
        if (!entry) {
          sweep(nowMs);
          if (entries.size >= maxScopes) {
            if (!warned) {
              warned = true;
              options.onWarning?.(
                `memoryUsageStore reached maxScopes (${maxScopes}), so new scopes are not limited`,
              );
            }
            used.push(0);
            continue;
          }
          entry = { spent: zero(), reserved: zero(), resetsAtMs: scope.resetsAtMs };
          entries.set(scope.key, entry);
          nextSweepAtMs = Math.min(nextSweepAtMs, scope.resetsAtMs);
        }
        entry.reserved.nanoUsd += amount.nanoUsd;
        entry.reserved.tokens += amount.tokens;
        held.push(scope);
        used.push(unitOf(entry.spent, scope.unit) + unitOf(entry.reserved, scope.unit));
      }

      const id = `res_${++nextId}`;
      reservations.set(id, { scopes: held, amount: copy(amount), expiresAtMs: nowMs + ttlMs });
      return { ok: true, id, used };
    },

    commit(id, actual) {
      const reservation = reservations.get(id);
      if (reservation) {
        reservations.delete(id);
        unhold(reservation);
        spend(reservation.scopes, actual);
        return;
      }

      // Expired while the call ran: the hold is already freed, but the spend still counts. An
      // unknown id was settled before, so it adds nothing.
      const late = expired.get(id);
      if (!late) return;
      expired.delete(id);
      spend(late.scopes, actual);
    },

    release(id) {
      const reservation = reservations.get(id);
      if (!reservation) {
        expired.delete(id);
        return;
      }

      reservations.delete(id);
      unhold(reservation);
    },

    read(scope) {
      expire(Date.now());
      const entry = entries.get(scope.key);
      return entry
        ? { spent: copy(entry.spent), reserved: copy(entry.reserved) }
        : { spent: zero(), reserved: zero() };
    },
  };
}
