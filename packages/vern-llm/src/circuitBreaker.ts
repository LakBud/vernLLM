import { LLMError, type LLMErrorCode } from './types/errors.js';

import type { MiddlewareStateBag } from './types/middleware.js';

/** The call this mutation happened as part of, forwarded to `onStateChange` untouched. `CircuitBreaker` never inspects it. */
export interface CircuitBreakerCallContext {
  requestId: string;
  state: MiddlewareStateBag;
  signal?: AbortSignal;
  /**
   * The real, current attempt number for this dispatch, when the call
   * site actually has one in scope (i.e. after a dispatch was made or
   * failed). Omitted for calls that happen before any attempt exists,
   * like `assertClosed`'s pre-dispatch check.
   */
  attempt?: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens, default 5 */
  threshold?: number;
  /** How long the circuit stays open before allowing a trial request, in ms. Default 30000 */
  cooldownMs?: number;
  /**
   * Called after every real state change, never for a no-op transition
   * (e.g. open to open). `model` is the resolved model of whichever call
   * triggered this specific transition (the `model` passed to whichever
   * of `assertClosed`/`recordSuccess`/`recordFailure` caused it).
   *
   * With `isolateByModel` off (the default), this is a label only: the
   * breaker still counts failures across every model together, so a
   * threshold crossing can be the sum of several different models'
   * failures even though only the triggering call's `model` is reported
   * here. With `isolateByModel` on, it's exact: each model has its own
   * counter, so the transition really was caused solely by that model.
   */
  onStateChange?: (
    from: CircuitState,
    to: CircuitState,
    consecutiveFailures: number,
    model?: string,
    /** See `CircuitBreakerCallContext`. */
    context?: CircuitBreakerCallContext,
  ) => void;
  /**
   * Track a separate circuit per resolved model instead of one shared
   * circuit for the whole instance. A failure on one model then never
   * opens another model's circuit, at the cost of slower detection for
   * an outage spread across many distinct models (each model's counter
   * must independently cross `threshold`). Default false: one shared
   * circuit, matching every version before this option existed.
   *
   * A call that omits `model` (only possible calling `CircuitBreaker`
   * directly, `VernLLM` always passes one) falls into one shared bucket
   * alongside every other call that also omits it.
   */
  isolateByModel?: boolean;
  /**
   * Trial calls allowed through per half-open cycle, instead of exactly
   * one. Default 1, matching every version before this option existed.
   * Clamped to at least 1 at construction, a half-open circuit that
   * admits zero trials could never recover.
   */
  halfOpenProbes?: number;
  /**
   * Fraction of `halfOpenProbes` that must succeed to close the circuit
   * again. Default 1, meaning every trial must succeed, matching every
   * version before this option existed. Clamped to `[0, 1]` at
   * construction.
   */
  halfOpenSuccessRatio?: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Mutable state for one circuit, either the single shared one or one model's bucket under `isolateByModel`. */
interface CircuitBucket {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  /**
   * Non null only while `state` is half-open. Set in `transition()` the
   * moment a bucket enters half-open, cleared back to null the moment it
   * leaves, so a caller never has to reconcile several flat fields that
   * could in principle desync. `slotsRemaining` guards against more than
   * `halfOpenProbes` concurrent callers all treating themselves as a
   * trial once the cooldown elapses; `successes`/`failures` decide,
   * once every admitted trial has resolved, whether the circuit closes
   * or reopens.
   */
  trial: { slotsRemaining: number; successes: number; failures: number } | null;
}

function newBucket(): CircuitBucket {
  return { state: 'closed', consecutiveFailures: 0, openedAt: 0, trial: null };
}

/** Key a bucket lookup falls into when the call omitted `model` under `isolateByModel`. */
const UNLABELED_MODEL = '';

/**
 * Maps each call's `CircuitBreakerCallContext.state` to the trial object
 * it claimed a slot in. `bucket.trial` is a fresh object per half-open
 * cycle, so identity alone tells a current permit from a stale one. No
 * `context` (direct `CircuitBreaker` use) always counts, unchanged from
 * before permit tracking existed.
 */
const trialPermits = new WeakMap<object, object>();

/**
 * Per retry VernLLM-instance circuit breaker. Tracks consecutive failures across
 * calls. Once the threshold is hit, short-circuits new calls with an
 * LLMError('circuit_open') instead of hitting the provider, until the
 * cooldown elapses and up to `halfOpenProbes` trial calls (default 1)
 * are allowed through
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly onStateChange?: CircuitBreakerOptions['onStateChange'];
  /** Whether this breaker tracks failures per model instead of one shared circuit. Read by `CallExecutor`/`VernLLM` to report per-target in `getCircuitStates`. */
  readonly isolateByModel: boolean;
  private readonly halfOpenProbes: number;
  private readonly halfOpenSuccessRatio: number;

  // Exactly one of these is used, chosen once at construction by
  // `isolateByModel`, so every method has a single, unambiguous place to
  // resolve a bucket from instead of branching on the flag repeatedly.
  private readonly sharedBucket: CircuitBucket = newBucket();
  private readonly bucketsByModel = new Map<string, CircuitBucket>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.onStateChange = options.onStateChange;
    this.isolateByModel = options.isolateByModel ?? false;
    // Clamped rather than thrown, same as `TokenBucket.give`. `Number.isFinite`
    // catches NaN/Infinity, which would otherwise bypass or break the clamp.
    const rawProbes = options.halfOpenProbes;
    this.halfOpenProbes = Number.isFinite(rawProbes) ? Math.max(1, Math.floor(rawProbes!)) : 1;

    const rawRatio = options.halfOpenSuccessRatio;
    this.halfOpenSuccessRatio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio!)) : 1;
  }

  /** Returns the bucket for a model if one already exists, without allocating. */
  private lookupBucket(model: string | undefined): CircuitBucket | undefined {
    if (!this.isolateByModel) return this.sharedBucket;

    const key = model ?? UNLABELED_MODEL;
    return this.bucketsByModel.get(key);
  }

  /** Creates and stores a bucket for a model when the first mutation needs one. */
  private ensureBucketFor(model: string | undefined): CircuitBucket {
    if (!this.isolateByModel) return this.sharedBucket;

    const key = model ?? UNLABELED_MODEL;
    let bucket = this.bucketsByModel.get(key);

    if (!bucket) {
      bucket = newBucket();
      this.bucketsByModel.set(key, bucket);
    }

    return bucket;
  }

  /** True if this outcome's call claimed a permit for `bucket`'s current trial. Stale or unstamped calls don't. */
  private claimsCurrentTrial(
    bucket: CircuitBucket,
    context: CircuitBreakerCallContext | undefined,
  ): boolean {
    if (!context) return true;
    return trialPermits.get(context.state) === bucket.trial;
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

  /**
   * Throws if the circuit is open and the cooldown hasn't elapsed, or if
   * the circuit is half-open and every trial slot (`halfOpenProbes`,
   * default 1) is already claimed. Otherwise, if the circuit just became
   * eligible for a trial (cooldown elapsed) or still has a free slot
   * (already half-open), this call claims one.
   */
  assertClosed(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);

    if (bucket.state === 'closed') return;

    if (bucket.state === 'open') {
      const elapsed = Date.now() - bucket.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new LLMError(
          `Circuit open, provider has failed ${bucket.consecutiveFailures} times in a row. Retry in ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s.`,
          'circuit_open',
          { code: 'circuit_cooling_down' },
        );
      }

      // Set before transition(): a synchronous onStateChange observer
      // that re-enters (e.g. calls assertClosed again) must see this
      // call as already claiming a trial slot, not still eligible for
      // one. `slotsRemaining - 1` since this call itself consumes one.
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

    if (bucket.state === 'half-open' && bucket.trial && this.claimsCurrentTrial(bucket, context)) {
      bucket.trial.successes += 1;
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't settle a trial it wasn't part of.
    if (bucket.state === 'half-open') return;

    bucket.consecutiveFailures = 0;
    bucket.trial = null;
    this.transition(bucket, 'closed', model, context);

    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.bucketsByModel.delete(model ?? UNLABELED_MODEL);
    }
  }

  /**
   * `code`, when present, is the failing `LLMError`'s `code`. Not read by
   * `CircuitBreaker` itself yet, threaded through so later attribution
   * work has it available without changing this signature again.
   */
  recordFailure(model?: string, context?: CircuitBreakerCallContext, _code?: LLMErrorCode): void {
    const bucket = this.ensureBucketFor(model);

    if (bucket.state === 'half-open' && bucket.trial && this.claimsCurrentTrial(bucket, context)) {
      bucket.trial.failures += 1;
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't fall through to the closed-state counter below.
    if (bucket.state === 'half-open') return;

    bucket.consecutiveFailures += 1;

    if (bucket.consecutiveFailures >= this.threshold) {
      bucket.openedAt = Date.now();
      this.transition(bucket, 'open', model, context);
    }
  }

  /**
   * Once every admitted trial in a half-open bucket has reported in
   * (`successes + failures` reaches `halfOpenProbes`), decides whether
   * to close or reopen based on `halfOpenSuccessRatio`, and clears
   * `trial` either way, since it's only ever non null while half-open.
   * A no-op while trials are still outstanding.
   */
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
      this.transition(bucket, 'closed', model, context);

      if (this.isolateByModel && bucket.state === 'closed') {
        this.bucketsByModel.delete(model ?? UNLABELED_MODEL);
      }
      return;
    }

    // Trial failed the ratio: reopen and reset the cooldown window. Set
    // before transition() for the same reason as assertClosed above: a
    // synchronous observer must see the fresh cooldown, not a stale or
    // zeroed one.
    bucket.openedAt = Date.now();
    this.transition(bucket, 'open', model, context);
  }

  /**
   * With `isolateByModel` off (the default), `model` is ignored and the
   * one shared circuit's state is returned, unchanged from every version
   * before this option existed. With `isolateByModel` on, returns that
   * model's own state, `'closed'` for a model never seen yet, same as a
   * fresh breaker.
   */
  getState(model?: string): CircuitState {
    return this.lookupBucket(model)?.state ?? 'closed';
  }

  /**
   * Manually opens the circuit, as if `threshold` consecutive failures had
   * just happened, e.g. to pull a provider out of rotation ahead of known
   * maintenance. Resets the cooldown window from now, same as a real
   * threshold-crossing failure would, and clears any in-flight half-open
   * trial since it no longer applies once the circuit is (re)opened.
   */
  open(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);

    bucket.openedAt = Date.now();
    bucket.trial = null;
    this.transition(bucket, 'open', model, context);
  }

  /**
   * Manually closes the circuit and resets its failure count, e.g. once a
   * provider is confirmed healthy again without waiting out the cooldown.
   * Mirrors `recordSuccess`'s bookkeeping (including dropping the
   * per-model bucket under `isolateByModel`, once idle) but without
   * requiring an actual successful call first.
   */
  close(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);

    bucket.consecutiveFailures = 0;
    bucket.trial = null;
    this.transition(bucket, 'closed', model, context);

    // transition() may have synchronously re-entered (e.g. an
    // onStateChange callback that calls open(model) on this same
    // bucket), so re-check state/consecutiveFailures rather than
    // assuming they still hold the values set above, same as
    // recordSuccess does.
    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.bucketsByModel.delete(model ?? UNLABELED_MODEL);
    }
  }
}
