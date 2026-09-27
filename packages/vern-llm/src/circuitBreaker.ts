import { RollingRatio } from './internal/rollingRatio.js';
import {
  attributeFailure,
  buildCooldownBackoff,
  claimsCurrentTrial,
  keyFor,
  newBucket,
  resetBucket,
  trialPermits,
  UNLABELED_MODEL,
  type CircuitBucket,
} from './internal/utils/circuit-breaker/circuitBucket.utils.js';
import { validateMinCalls, validateRatio } from './internal/utils/validate.utils.js';
import { LLMError, type LLMErrorCode } from './types/errors.js';

import type { Logger } from './logger.js';
import type { MiddlewareStateBag } from './types/middleware.js';

/** The call this mutation happened as part of, forwarded to `onStateChange` untouched. */
export interface CircuitBreakerCallContext {
  requestId: string;
  state: MiddlewareStateBag;
  signal?: AbortSignal;
  /** Omitted for calls before any attempt exists, like `assertClosed`'s pre-dispatch check. */
  attempt?: number;
}

/**
 * Fires after every real state change. `model` is the triggering call's resolved model. Shared by
 * the options and the adapter interface, so custom adapters report changes the same way.
 */
export type CircuitBreakerStateChangeHandler = (
  from: CircuitState,
  to: CircuitState,
  consecutiveFailures: number,
  model?: string,
  context?: CircuitBreakerCallContext,
) => void;

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens, default 5 */
  threshold?: number;
  /** How long the circuit stays open before allowing a trial request, in ms. Default 30000 */
  cooldownMs?: number;
  onStateChange?: CircuitBreakerStateChangeHandler;
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
   * When failures open the circuit. `{ kind: 'consecutive', threshold }` (default) opens after that
   * many in a row; `{ kind: 'rolling', windowMs, minCalls, failureRatio }` opens once `minCalls`
   * calls in the window reach `failureRatio`. Invalid values throw `RangeError` at construction. A
   * custom `TrippingPolicy` is shared across models, keyed per model.
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

/**
 * Decides when failures open the circuit. Keyed by model (or one shared key), so one instance
 * serves every bucket.
 */
export interface TrippingPolicy {
  onSuccess(key: string): void;
  /** Returns true if this failure should open the circuit for `key`. */
  onFailure(key: string): boolean;
  reset(key: string): void;
  /**
   * Called when `key`'s circuit is reset closed, so a keyed policy can drop that key's state. Not
   * called on an ordinary success, whose state a rolling window still needs.
   */
  forget?(key: string): void;
}

export class ConsecutiveTripping implements TrippingPolicy {
  private failuresByKey = new Map<string, number>();

  constructor(private readonly threshold: number) {}

  onSuccess(key: string): void {
    // Delete rather than store 0: same count, and an idle key holds no memory.
    this.failuresByKey.delete(key);
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
    validateMinCalls(minCalls);
    validateRatio(failureRatio, 'failureRatio');
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

/**
 * What VernLLM needs from a breaker. Pass your own for cross-process coordination. `onStateChange`
 * is required so `circuit_state` events can't go missing; `() => {}` is fine. Omitting an optional
 * member makes that call a no-op, as with no breaker. `open` and `close` are optional, since a
 * distributed adapter may not allow forced transitions.
 */
export interface CircuitBreakerAdapter {
  /** Throws when the circuit is open (or half open with no trial slot free) for `model`. */
  assertClosed(model?: string, context?: CircuitBreakerCallContext): void;
  recordSuccess(model?: string, context?: CircuitBreakerCallContext): void;
  /** `code`, when present, is the failing call's `LLMErrorCode`. */
  recordFailure(model?: string, context?: CircuitBreakerCallContext, code?: LLMErrorCode): void;
  getState?(model?: string): CircuitState;
  /** Failure counts by `LLMErrorCode` for `model`'s bucket, `'unknown'` for one that carried no code. */
  getFailureBreakdown?(model?: string): Partial<Record<LLMErrorCode | 'unknown', number>>;
  /** Whether this adapter tracks failures per model, mirroring `CircuitBreakerOptions.isolateByModel`. Read by `warnIfModelUnsupported`'s diagnostic warning and by `VernLLM.getCircuitStates()`'s public output; omit if the notion doesn't apply to your adapter, `false` is assumed. */
  isolateByModel?: boolean;
  /** Manually opens the circuit, as if enough consecutive failures had just happened. Optional: an adapter that doesn't want external callers forcing a transition can omit it. */
  open?(model?: string, context?: CircuitBreakerCallContext): void;
  /** Manually closes the circuit, without requiring a real success first. Same opt-in reasoning as `open`. */
  close?(model?: string, context?: CircuitBreakerCallContext): void;
  /** Gives back a half-open trial slot when a call ends without `recordSuccess` or `recordFailure`. Idempotent, and a no-op for a call that holds no slot. */
  releaseTrial?(model?: string, context?: CircuitBreakerCallContext): void;
  /** Awaited right before `assertClosed` to refresh local state. Never blocks or fails a call: a rejection or `prepareTimeoutMs` is logged and the call carries on. */
  prepare?(model?: string, context?: CircuitBreakerCallContext): Promise<void>;
  /** How long to wait for `prepare`, in ms. Default 1000. */
  prepareTimeoutMs?: number;
  /** Live counterpart of `getState`, read by `VernLLM.readCircuitStates()`. */
  readState?(model?: string): Promise<CircuitState>;
  /** Receives the instance's `Logger` once, when `VernLLM` wires this adapter in. */
  setLogger?(logger: Logger): void;
  /**
   * Called after every real state change, after VernLLM reports its `circuit_state` event. A throw
   * here is caught and logged.
   */
  onStateChange: CircuitBreakerStateChangeHandler;
}

/**
 * Per retry VernLLM-instance circuit breaker. Tracks consecutive failures
 * across calls. Once the threshold is hit, short-circuits new calls with
 * LLMError('circuit_open') until the cooldown elapses and a trial succeeds.
 */
export class CircuitBreaker implements CircuitBreakerAdapter {
  private readonly cooldownMs: number;
  /** Satisfies `CircuitBreakerAdapter.onStateChange`, required there. Defaults to a no-op when `options.onStateChange` is omitted. */
  readonly onStateChange: CircuitBreakerStateChangeHandler;
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

  /**
   * Breaker-wide rather than per bucket, since an evicted bucket is
   * recreated with no history and a per bucket generation would restart.
   */
  private generation = 0;
  /** Each call's generation at admission, keyed by its `state`, so its outcome can be told apart from a later generation's. */
  private readonly admittedInGeneration = new WeakMap<object, number>();

  constructor(options: CircuitBreakerOptions = {}) {
    const threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.onStateChange = options.onStateChange ?? (() => {});
    this.isolateByModel = options.isolateByModel ?? false;
    // Clamped rather than thrown, same as `TokenBucket.give`.
    const rawProbes = options.halfOpenProbes;
    this.halfOpenProbes = Number.isFinite(rawProbes) ? Math.max(1, Math.floor(rawProbes!)) : 1;

    const rawRatio = options.halfOpenSuccessRatio;
    this.halfOpenSuccessRatio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio!)) : 1;

    this.cooldownBackoff = buildCooldownBackoff(options.cooldownBackoff);
    this.tripping = buildTripping(options.tripping ?? { kind: 'consecutive', threshold });
  }

  /**
   * Throws if the circuit is open and the cooldown hasn't elapsed, or if
   * half-open with every trial slot claimed. Otherwise claims a trial slot.
   */
  assertClosed(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);

    if (bucket.state === 'closed') {
      this.markAdmitted(context);
      return;
    }

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
      this.markAdmitted(context);
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
    this.markAdmitted(context);
  }

  recordSuccess(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.lookupBucket(model);

    if (!bucket) {
      return;
    }

    if (this.isFromEarlierGeneration(bucket, context)) return;

    if (bucket.state === 'half-open' && bucket.trial && claimsCurrentTrial(bucket, context)) {
      // Outcome recorded, so this call's permit is spent: a later
      // `releaseTrial` for the same call must not hand its slot back.
      if (context) trialPermits.delete(context.state);
      bucket.trial.successes += 1;
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't settle a trial it wasn't part of.
    if (bucket.state === 'half-open') return;

    // A call admitted before the circuit opened can finish after it. Only
    // a half-open trial may close an open circuit, never a late straggler.
    if (bucket.state === 'open') return;

    resetBucket(bucket);
    this.tripping.onSuccess(this.trippingKeyFor(model));
    this.transition(bucket, 'closed', model, context);

    // Drop only the idle bucket. The tripping state stays, since a rolling
    // window must keep this success and earlier failures to ever trip.
    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.dropBucket(model);
    }
  }

  /** `code`, when present, is the failing `LLMError`'s `code`. Missing attributes to `'unknown'`. */
  recordFailure(model?: string, context?: CircuitBreakerCallContext, code?: LLMErrorCode): void {
    const bucket = this.ensureBucketFor(model);

    if (this.isFromEarlierGeneration(bucket, context)) return;

    if (bucket.state === 'half-open' && bucket.trial && claimsCurrentTrial(bucket, context)) {
      if (context) trialPermits.delete(context.state);
      bucket.trial.failures += 1;
      attributeFailure(bucket, code);
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't fall through to the closed-state counter below.
    if (bucket.state === 'half-open') return;

    // A late failure from a call admitted before the circuit opened would
    // otherwise re-trip it, restamping `openedAt` and extending the cooldown.
    if (bucket.state === 'open') return;

    bucket.consecutiveFailures += 1;
    attributeFailure(bucket, code);

    if (this.tripping.onFailure(this.trippingKeyFor(model))) {
      this.openBucket(bucket, model, context);
    }
  }

  /**
   * Gives back the trial slot `context`'s call claimed when it ended without an outcome. Safe to
   * call on any failure path: a no-op without a live permit.
   */
  releaseTrial(model?: string, context?: CircuitBreakerCallContext): void {
    if (!context) return;

    const bucket = this.lookupBucket(model);
    if (!bucket || bucket.state !== 'half-open' || !bucket.trial) return;
    if (!claimsCurrentTrial(bucket, context)) return;

    trialPermits.delete(context.state);
    bucket.trial.slotsRemaining += 1;
  }

  /**
   * The current state. Ignores `model` unless isolated by model. An open circuit past its cooldown
   * reports `'half-open'`, though the real transition waits for the next call.
   */
  getState(model?: string): CircuitState {
    const bucket = this.lookupBucket(model);
    if (!bucket) return 'closed';
    if (bucket.state === 'open' && Date.now() - bucket.openedAt >= bucket.cooldownMsForOpen) {
      return 'half-open';
    }
    return bucket.state;
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

    resetBucket(bucket);
    this.tripping.reset(this.trippingKeyFor(model));
    this.transition(bucket, 'closed', model, context);

    // transition() may have synchronously re-entered, so re-check state rather than assuming it still holds.
    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.forgetModel(model);
    }
  }

  /**
   * Stamps the open time and cooldown, then transitions to open. Callers have already cleared
   * `trial`.
   */
  private openBucket(
    bucket: CircuitBucket,
    model: string | undefined,
    context: CircuitBreakerCallContext | undefined,
  ): void {
    bucket.openedAt = Date.now();
    bucket.cooldownMsForOpen = this.computeCooldown(bucket);
    bucket.openedInGeneration = ++this.generation;
    this.transition(bucket, 'open', model, context);
  }

  /** Computes and clamps the cooldown for `bucket`'s current `reopenCount`. Called once, on open. */
  private computeCooldown(bucket: CircuitBucket): number {
    if (!this.cooldownBackoff) return this.cooldownMs;

    const computed = this.cooldownBackoff(bucket.reopenCount, this.cooldownMs);
    if (Number.isNaN(computed)) return 0;
    return Math.max(0, computed);
  }

  private markAdmitted(context: CircuitBreakerCallContext | undefined): void {
    if (context) this.admittedInGeneration.set(context.state, this.generation);
  }

  /**
   * True if this call was admitted before `bucket` last opened, so its outcome belongs to an ended
   * generation. A call without context always counts.
   */
  private isFromEarlierGeneration(
    bucket: CircuitBucket,
    context: CircuitBreakerCallContext | undefined,
  ): boolean {
    if (!context) return false;
    const admitted = this.admittedInGeneration.get(context.state);
    return admitted !== undefined && admitted < bucket.openedInGeneration;
  }

  /** Returns the bucket for a model if one already exists, without allocating. */
  private lookupBucket(model: string | undefined): CircuitBucket | undefined {
    if (!this.isolateByModel) return this.sharedBucket;
    return this.bucketsByModel.get(keyFor(model));
  }

  /**
   * The key for `tripping`: per model when isolated by model, otherwise one shared key, matching
   * which bucket a call lands in.
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

  /** Drops an idle model's bucket, keeping its tripping state. */
  private dropBucket(model: string | undefined): void {
    this.bucketsByModel.delete(keyFor(model));
  }

  /** Drops a reset model's bucket and lets `tripping` release that key's state too. */
  private forgetModel(model: string | undefined): void {
    this.dropBucket(model);
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
    this.onStateChange(from, to, bucket.consecutiveFailures, model, context);
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
      resetBucket(bucket);
      // Reset rather than record a success, so failures from before the
      // circuit opened can't push a rolling window straight back over
      // its threshold. Same as the manual `close()`.
      this.tripping.reset(this.trippingKeyFor(model));
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
