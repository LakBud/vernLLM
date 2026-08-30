import { fullJitter } from './internal/execution/utils/retry/retry.utils.js';
import { RollingRatio } from './internal/rollingRatio.js';
import { LLMError, type LLMErrorCode } from './types/errors.js';

import type { MiddlewareStateBag } from './types/middleware.js';

/** The call this mutation happened as part of, forwarded to `onStateChange` untouched. */
export interface CircuitBreakerCallContext {
  requestId: string;
  state: MiddlewareStateBag;
  signal?: AbortSignal;
  /** Omitted for calls before any attempt exists, like `assertClosed`'s pre-dispatch check. */
  attempt?: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens, default 5 */
  threshold?: number;
  /** How long the circuit stays open before allowing a trial request, in ms. Default 30000 */
  cooldownMs?: number;
  /**
   * Fires after every real state change, never a no-op transition. `model`
   * is the resolved model of whichever call triggered it. With
   * `isolateByModel` off, failures are still counted across every model.
   */
  onStateChange?: (
    from: CircuitState,
    to: CircuitState,
    consecutiveFailures: number,
    model?: string,
    context?: CircuitBreakerCallContext,
  ) => void;
  /**
   * Track a separate circuit per resolved model instead of one shared
   * circuit. Default false. A call that omits `model` falls into one
   * shared bucket alongside every other call that also omits it.
   */
  isolateByModel?: boolean;
  /** Trial calls allowed through per half-open cycle. Default 1, clamped to at least 1. */
  halfOpenProbes?: number;
  /** Fraction of `halfOpenProbes` that must succeed to close the circuit. Default 1, clamped to `[0, 1]`. */
  halfOpenSuccessRatio?: number;
  /**
   * Grows `cooldownMs` on each repeat open instead of a fixed wait.
   * `{ multiplier, maxMs }` covers exponential growth; a `CooldownBackoff`
   * function covers anything else. Omitted means `cooldownMs` stays fixed.
   */
  cooldownBackoff?: ExponentialBackoffOptions | CooldownBackoff;
  /**
   * Decides when a bucket's failures should open the circuit.
   * `{ kind: 'consecutive', threshold }` (the default) opens after that
   * many failures in a row. `{ kind: 'rolling', windowMs, minCalls,
   * failureRatio }` opens once at least `minCalls` calls have landed in
   * the trailing `windowMs` and the failure ratio reaches `failureRatio`.
   * A `TrippingPolicy` covers anything else, one instance shared across
   * every model automatically under `isolateByModel`, since it tracks its
   * own state per key rather than owning one flat counter.
   */
  tripping?: TrippingOption;
}

/** Computes the cooldown for a bucket's `reopenCount`-th repeat open. */
export type CooldownBackoff = (reopenCount: number, baseCooldownMs: number) => number;

export interface ExponentialBackoffOptions {
  /** Growth factor applied per repeat open, e.g. 2 doubles each time. */
  multiplier: number;
  /** Upper bound on the computed cooldown, in ms. Default `Infinity`. */
  maxMs?: number;
}

/** Not exported. Applies full jitter so several instances don't reopen in lockstep. */
function buildCooldownBackoff(
  option: ExponentialBackoffOptions | CooldownBackoff | undefined,
): CooldownBackoff | undefined {
  if (option === undefined) return undefined;
  if (typeof option === 'function') return option;

  const { multiplier, maxMs = Infinity } = option;
  return (reopenCount, baseCooldownMs) => {
    const exp = Math.min(baseCooldownMs * multiplier ** reopenCount, maxMs);
    return fullJitter(exp);
  };
}

/**
 * Decides when a bucket's failures should open the circuit. Keyed by
 * `key` (a resolved model, or the shared bucket's key when
 * `isolateByModel` is off) rather than holding one flat counter, so a
 * single `TrippingPolicy` instance is always safe to share across every
 * bucket: `CircuitBreaker` never needs to clone or construct a fresh one
 * per model, `isolateByModel` isolation falls out of `key` alone.
 */
export interface TrippingPolicy {
  onSuccess(key: string): void;
  /** Returns true if this failure should open the circuit for `key`. */
  onFailure(key: string): boolean;
  reset(key: string): void;
  /**
   * Called when `key`'s bucket is discarded (closed and idle, under
   * `isolateByModel`), so a keyed policy can release that key's state.
   * Optional: omit if there's nothing to release.
   */
  forget?(key: string): void;
}

export class ConsecutiveTripping implements TrippingPolicy {
  private failuresByKey = new Map<string, number>();

  constructor(private readonly threshold: number) {}

  onSuccess(key: string): void {
    this.failuresByKey.set(key, 0);
  }

  onFailure(key: string): boolean {
    const next = (this.failuresByKey.get(key) ?? 0) + 1;
    this.failuresByKey.set(key, next);
    return next >= this.threshold;
  }

  reset(key: string): void {
    this.failuresByKey.set(key, 0);
  }

  forget(key: string): void {
    this.failuresByKey.delete(key);
  }
}

export class RollingTripping implements TrippingPolicy {
  private ratiosByKey = new Map<string, RollingRatio>();

  constructor(
    private readonly windowMs: number,
    private readonly minCalls: number,
    private readonly failureRatio: number,
  ) {
    // Fail at construction rather than on the first recorded outcome.
    new RollingRatio(windowMs);
  }

  private ratioFor(key: string): RollingRatio {
    let ratio = this.ratiosByKey.get(key);
    if (!ratio) {
      ratio = new RollingRatio(this.windowMs);
      this.ratiosByKey.set(key, ratio);
    }
    return ratio;
  }

  onSuccess(key: string): void {
    this.ratioFor(key).record(false);
  }

  onFailure(key: string): boolean {
    const ratio = this.ratioFor(key);
    ratio.record(true);
    return ratio.getCount() >= this.minCalls && ratio.getRatio() >= this.failureRatio;
  }

  reset(key: string): void {
    this.ratiosByKey.delete(key);
  }

  forget(key: string): void {
    this.ratiosByKey.delete(key);
  }
}

/** Not exported. Internal shorthand union for `CircuitBreakerOptions.tripping`. */
type TrippingOption =
  | { kind: 'consecutive'; threshold: number }
  | { kind: 'rolling'; windowMs: number; minCalls: number; failureRatio: number }
  | TrippingPolicy;

/** Resolves the shorthand into a real `TrippingPolicy`. One instance total, shared safely across every bucket since it's keyed. */
function buildTripping(option: TrippingOption): TrippingPolicy {
  if ('onFailure' in option) return option;

  return option.kind === 'consecutive'
    ? new ConsecutiveTripping(option.threshold)
    : new RollingTripping(option.windowMs, option.minCalls, option.failureRatio);
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Mutable state for one circuit, either the single shared one or one model's bucket under `isolateByModel`. */
interface CircuitBucket {
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
}

function newBucket(): CircuitBucket {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    openedAt: 0,
    trial: null,
    reopenCount: 0,
    failuresByReason: new Map(),
    cooldownMsForOpen: 0,
  };
}

/** Key a bucket lookup falls into when the call omitted `model` under `isolateByModel`. Also the `tripping` key for the single shared bucket when `isolateByModel` is off. */
const UNLABELED_MODEL = '';

/** Resolves the map key for a model, collapsing an omitted `model` to `UNLABELED_MODEL`. Pure, no `this` needed. */
function keyFor(model: string | undefined): string {
  return model ?? UNLABELED_MODEL;
}

/** Maps a call's `state` to the trial object it claimed a slot in, so a stale permit can be told apart from a current one. */
const trialPermits = new WeakMap<object, object>();

/** True if this outcome's call claimed a permit for `bucket`'s current trial. No `context` always counts, matching pre-permit-tracking behavior. */
function claimsCurrentTrial(
  bucket: CircuitBucket,
  context: CircuitBreakerCallContext | undefined,
): boolean {
  if (!context) return true;
  return trialPermits.get(context.state) === bucket.trial;
}

/** Records `code` (or `'unknown'` if omitted) against `bucket.failuresByReason`. */
function attributeFailure(bucket: CircuitBucket, code: LLMErrorCode | undefined): void {
  const key = code ?? 'unknown';
  bucket.failuresByReason.set(key, (bucket.failuresByReason.get(key) ?? 0) + 1);
}

/**
 * Per retry VernLLM-instance circuit breaker. Tracks consecutive failures
 * across calls. Once the threshold is hit, short-circuits new calls with
 * LLMError('circuit_open') until the cooldown elapses and a trial succeeds.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly onStateChange?: CircuitBreakerOptions['onStateChange'];
  /** Whether this breaker tracks failures per model instead of one shared circuit. */
  readonly isolateByModel: boolean;
  private readonly halfOpenProbes: number;
  private readonly halfOpenSuccessRatio: number;
  private readonly cooldownBackoff?: CooldownBackoff;
  /** One instance, keyed per model internally. See `TrippingPolicy`. */
  private readonly tripping: TrippingPolicy;

  // Exactly one of these is used, chosen once at construction by `isolateByModel`.
  private readonly sharedBucket: CircuitBucket = newBucket();
  private readonly bucketsByModel = new Map<string, CircuitBucket>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.onStateChange = options.onStateChange;
    this.isolateByModel = options.isolateByModel ?? false;
    // Clamped rather than thrown, same as `TokenBucket.give`.
    const rawProbes = options.halfOpenProbes;
    this.halfOpenProbes = Number.isFinite(rawProbes) ? Math.max(1, Math.floor(rawProbes!)) : 1;

    const rawRatio = options.halfOpenSuccessRatio;
    this.halfOpenSuccessRatio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio!)) : 1;

    this.cooldownBackoff = buildCooldownBackoff(options.cooldownBackoff);
    this.tripping = buildTripping(
      options.tripping ?? { kind: 'consecutive', threshold: this.threshold },
    );
  }

  /**
   * Throws if the circuit is open and the cooldown hasn't elapsed, or if
   * half-open with every trial slot claimed. Otherwise claims a trial slot.
   */
  assertClosed(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);

    if (bucket.state === 'closed') return;

    if (bucket.state === 'open') {
      const elapsed = Date.now() - bucket.openedAt;
      const cooldown = bucket.cooldownMsForOpen;
      if (elapsed < cooldown) {
        throw new LLMError(
          `Circuit open, provider has failed ${bucket.consecutiveFailures} times in a row. Retry in ${Math.ceil((cooldown - elapsed) / 1000)}s.`,
          'circuit_open',
          { code: 'circuit_cooling_down' },
        );
      }

      // Set before transition() so a synchronous re-entrant caller sees the slot as already claimed.
      bucket.trial = { slotsRemaining: this.halfOpenProbes - 1, successes: 0, failures: 0 };
      if (context) trialPermits.set(context.state, bucket.trial);
      this.transition(bucket, 'half-open', model, context);
      return;
    }

    // state === 'half-open'
    if (!bucket.trial || bucket.trial.slotsRemaining <= 0) {
      throw new LLMError(
        'Circuit half-open. Every trial slot is already in flight. Try again shortly.',
        'circuit_open',
        { code: 'circuit_trial_in_flight' },
      );
    }

    bucket.trial.slotsRemaining -= 1;
    if (context) trialPermits.set(context.state, bucket.trial);
  }

  recordSuccess(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.lookupBucket(model);

    if (!bucket) {
      return;
    }

    if (bucket.state === 'half-open' && bucket.trial && claimsCurrentTrial(bucket, context)) {
      bucket.trial.successes += 1;
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't settle a trial it wasn't part of.
    if (bucket.state === 'half-open') return;

    bucket.consecutiveFailures = 0;
    this.tripping.onSuccess(this.trippingKeyFor(model));
    bucket.trial = null;
    bucket.reopenCount = 0;
    bucket.failuresByReason.clear();
    this.transition(bucket, 'closed', model, context);

    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.forgetModel(model);
    }
  }

  /** `code`, when present, is the failing `LLMError`'s `code`. Missing attributes to `'unknown'`. */
  recordFailure(model?: string, context?: CircuitBreakerCallContext, code?: LLMErrorCode): void {
    const bucket = this.ensureBucketFor(model);

    if (bucket.state === 'half-open' && bucket.trial && claimsCurrentTrial(bucket, context)) {
      bucket.trial.failures += 1;
      attributeFailure(bucket, code);
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't fall through to the closed-state counter below.
    if (bucket.state === 'half-open') return;

    bucket.consecutiveFailures += 1;
    attributeFailure(bucket, code);

    if (this.tripping.onFailure(this.trippingKeyFor(model))) {
      this.openBucket(bucket, model, context);
    }
  }

  /** With `isolateByModel` off, `model` is ignored and the shared circuit's state is returned. */
  getState(model?: string): CircuitState {
    return this.lookupBucket(model)?.state ?? 'closed';
  }

  /** Failure counts by `LLMErrorCode` for `model`'s bucket. Returned as a plain object copy. */
  getFailureBreakdown(model?: string): Partial<Record<LLMErrorCode | 'unknown', number>> {
    const bucket = this.lookupBucket(model);
    return bucket ? Object.fromEntries(bucket.failuresByReason) : {};
  }

  /** Manually opens the circuit, as if `threshold` consecutive failures had just happened. */
  open(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);
    bucket.trial = null;
    this.openBucket(bucket, model, context);
  }

  /** Manually closes the circuit and resets its failure count, without requiring a real success first. */
  close(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);

    bucket.consecutiveFailures = 0;
    this.tripping.reset(this.trippingKeyFor(model));
    bucket.trial = null;
    bucket.reopenCount = 0;
    bucket.failuresByReason.clear();
    this.transition(bucket, 'closed', model, context);

    // transition() may have synchronously re-entered, so re-check state rather than assuming it still holds.
    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.forgetModel(model);
    }
  }

  /**
   * Opens `bucket`: stamps `openedAt`/`cooldownMsForOpen` and transitions
   * to `open`. Shared by `recordFailure`'s trip, `settleTrialIfComplete`'s
   * reopen, and the manual `open()`, all of which reach this with
   * `bucket.trial` already `null`.
   */
  private openBucket(
    bucket: CircuitBucket,
    model: string | undefined,
    context: CircuitBreakerCallContext | undefined,
  ): void {
    bucket.openedAt = Date.now();
    bucket.cooldownMsForOpen = this.computeCooldown(bucket);
    this.transition(bucket, 'open', model, context);
  }

  /** Computes and clamps the cooldown for `bucket`'s current `reopenCount`. Called once, on open. */
  private computeCooldown(bucket: CircuitBucket): number {
    if (!this.cooldownBackoff) return this.cooldownMs;

    const computed = this.cooldownBackoff(bucket.reopenCount, this.cooldownMs);
    if (Number.isNaN(computed)) return 0;
    return Math.max(0, computed);
  }

  /** Returns the bucket for a model if one already exists, without allocating. */
  private lookupBucket(model: string | undefined): CircuitBucket | undefined {
    if (!this.isolateByModel) return this.sharedBucket;
    return this.bucketsByModel.get(keyFor(model));
  }

  /**
   * The key `tripping` is called with. Real per-model isolation under
   * `isolateByModel`, matching `ensureBucketFor`/`lookupBucket`'s own
   * per-model key. Otherwise one fixed shared key regardless of what
   * `model` was passed, matching `sharedBucket` being the one and only
   * bucket in that mode: `model` is never allowed to split tripping state
   * when `isolateByModel` is off, the same way it never splits which
   * bucket a call lands in.
   */
  private trippingKeyFor(model: string | undefined): string {
    return this.isolateByModel ? keyFor(model) : UNLABELED_MODEL;
  }

  /** Creates and stores a bucket for a model when the first mutation needs one. */
  private ensureBucketFor(model: string | undefined): CircuitBucket {
    if (!this.isolateByModel) return this.sharedBucket;

    const key = keyFor(model);
    let bucket = this.bucketsByModel.get(key);

    if (!bucket) {
      bucket = newBucket();
      this.bucketsByModel.set(key, bucket);
    }

    return bucket;
  }

  /** Drops an idle model's bucket and lets `tripping` release that key's state too. */
  private forgetModel(model: string | undefined): void {
    this.bucketsByModel.delete(keyFor(model));
    this.tripping.forget?.(this.trippingKeyFor(model));
  }

  /** Every state mutation routes through here, so `onStateChange` fires exactly once per real change. */
  private transition(
    bucket: CircuitBucket,
    to: CircuitState,
    model: string | undefined,
    context: CircuitBreakerCallContext | undefined,
  ): void {
    if (to === bucket.state) return;

    const from = bucket.state;
    bucket.state = to;
    this.onStateChange?.(from, to, bucket.consecutiveFailures, model, context);
  }

  /** Once every admitted trial has reported in, closes or reopens based on `halfOpenSuccessRatio`. */
  private settleTrialIfComplete(
    bucket: CircuitBucket,
    model: string | undefined,
    context: CircuitBreakerCallContext | undefined,
  ): void {
    const trial = bucket.trial;
    if (!trial || trial.successes + trial.failures < this.halfOpenProbes) return;

    const ratio = trial.successes / this.halfOpenProbes;
    bucket.trial = null;

    if (ratio >= this.halfOpenSuccessRatio) {
      bucket.consecutiveFailures = 0;
      this.tripping.onSuccess(this.trippingKeyFor(model));
      bucket.reopenCount = 0;
      bucket.failuresByReason.clear();
      this.transition(bucket, 'closed', model, context);

      if (this.isolateByModel && bucket.state === 'closed') {
        this.forgetModel(model);
      }
      return;
    }

    // Trial failed: reopen, reset the cooldown window, count the repeat.
    bucket.reopenCount += 1;
    this.openBucket(bucket, model, context);
  }
}
