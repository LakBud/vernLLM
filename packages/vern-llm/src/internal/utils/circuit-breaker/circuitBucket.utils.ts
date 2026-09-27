import { fullJitter } from '../../execution/utils/retry/retry.utils.js';

import type {
  CircuitBreakerCallContext,
  CircuitState,
  CooldownBackoff,
  ExponentialBackoffOptions,
} from '../../../circuitBreaker.js';
import type { LLMErrorCode } from '../../../types/errors.js';

/**
 * Jitters only the growth above `baseCooldownMs`, so several
 * instances don't reopen in lockstep but none ever cools down for less
 * than the configured base.
 */
export function buildCooldownBackoff(
  option: ExponentialBackoffOptions | CooldownBackoff | undefined,
): CooldownBackoff | undefined {
  if (option === undefined) return undefined;
  if (typeof option === 'function') return option;

  const { multiplier, maxMs = Infinity } = option;
  return (reopenCount, baseCooldownMs) => {
    const exp = Math.min(baseCooldownMs * multiplier ** reopenCount, maxMs);
    // Only an explicit `maxMs` below the base may lower the floor; a
    // shrinking `multiplier` must not. The ternary also maps a NaN `exp` to the floor.
    const floor = Math.min(baseCooldownMs, maxMs);
    const upper = exp > floor ? exp : floor;
    return floor + fullJitter(upper - floor);
  };
}

/** Mutable state for one circuit, either the single shared one or one model's bucket under `isolateByModel`. */
export interface CircuitBucket {
  state: CircuitState;
  /** True consecutive failures since the last success. Reporting only, independent of `tripping`. */
  consecutiveFailures: number;
  openedAt: number;
  /** Non null only while `state` is half-open. */
  trial: { slotsRemaining: number; successes: number; failures: number } | null;
  /** Times this bucket has reopened after a failed trial. Feeds `cooldownBackoff`. */
  reopenCount: number;
  /** Failure counts by `LLMErrorCode`, `'unknown'` for a missing code. Attribution only. */
  failuresByReason: Map<LLMErrorCode | 'unknown', number>;
  /** Cooldown for this open period, sampled once so a jittered value doesn't change mid-cooldown. */
  cooldownMsForOpen: number;
  /** Breaker-wide generation this bucket last opened in, 0 if never opened. */
  openedInGeneration: number;
}

export function newBucket(): CircuitBucket {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    openedAt: 0,
    trial: null,
    reopenCount: 0,
    failuresByReason: new Map(),
    cooldownMsForOpen: 0,
    openedInGeneration: 0,
  };
}

/** Key a bucket lookup falls into when the call omitted `model` under `isolateByModel`. Also the `tripping` key for the single shared bucket when `isolateByModel` is off. */
export const UNLABELED_MODEL = '';

/** Resolves the map key for a model, collapsing an omitted `model` to `UNLABELED_MODEL`. */
export function keyFor(model: string | undefined): string {
  return model ?? UNLABELED_MODEL;
}

/** Maps a call's `state` to the trial object it claimed a slot in, so a stale permit can be told apart from a current one. */
export const trialPermits = new WeakMap<object, object>();

/** True if this outcome's call claimed a permit for `bucket`'s current trial. No `context` always counts, matching pre-permit-tracking behavior. */
export function claimsCurrentTrial(
  bucket: CircuitBucket,
  context: CircuitBreakerCallContext | undefined,
): boolean {
  if (!context) return true;
  return trialPermits.get(context.state) === bucket.trial;
}

/** Records `code` (or `'unknown'` if omitted) against `bucket.failuresByReason`. */
export function attributeFailure(bucket: CircuitBucket, code: LLMErrorCode | undefined): void {
  const key = code ?? 'unknown';
  bucket.failuresByReason.set(key, (bucket.failuresByReason.get(key) ?? 0) + 1);
}

/** Clears a bucket's failure history, as every return to closed does. */
export function resetBucket(bucket: CircuitBucket): void {
  bucket.consecutiveFailures = 0;
  bucket.trial = null;
  bucket.reopenCount = 0;
  bucket.failuresByReason.clear();
}
