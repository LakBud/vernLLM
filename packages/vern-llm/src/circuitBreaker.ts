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
   * A `TrippingPolicy` covers anything else.
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

/** Decides when a bucket's failures should open the circuit. */
export interface TrippingPolicy {
  onSuccess(): void;
  /** Returns true if this failure should open the circuit. */
  onFailure(): boolean;
  reset(): void;
}

export class ConsecutiveTripping implements TrippingPolicy {
  private failures = 0;

  constructor(private readonly threshold: number) {}

  onSuccess(): void {
    this.failures = 0;
  }

  onFailure(): boolean {
    this.failures += 1;
    return this.failures >= this.threshold;
  }

  reset(): void {
    this.failures = 0;
  }
}

export class RollingTripping implements TrippingPolicy {
  private readonly ratio: RollingRatio;

  constructor(
    windowMs: number,
    private readonly minCalls: number,
    private readonly failureRatio: number,
  ) {
    this.ratio = new RollingRatio(windowMs);
  }

  onSuccess(): void {
    this.ratio.record(false);
  }

  onFailure(): boolean {
    this.ratio.record(true);
    return this.ratio.getCount() >= this.minCalls && this.ratio.getRatio() >= this.failureRatio;
  }

  reset(): void {
    this.ratio.reset();
  }
}

/** Not exported. Internal shorthand union for `CircuitBreakerOptions.tripping`. */
type TrippingOption =
  | { kind: 'consecutive'; threshold: number }
  | { kind: 'rolling'; windowMs: number; minCalls: number; failureRatio: number }
  | TrippingPolicy;

/** Builds a factory, not a single instance, since each bucket needs its own tripping state. */
function buildTrippingFactory(option: TrippingOption): () => TrippingPolicy {
  if ('onFailure' in option) {
    return () => option;
  }

  return option.kind === 'consecutive'
    ? () => new ConsecutiveTripping(option.threshold)
    : () => new RollingTripping(option.windowMs, option.minCalls, option.failureRatio);
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Mutable state for one circuit, either the single shared one or one model's bucket under `isolateByModel`. */
interface CircuitBucket {
  state: CircuitState;
  /** True consecutive failures since the last success. Reporting only, independent of `tripping`. */
  consecutiveFailures: number;
  /** Owns the actual trip decision. See `TrippingPolicy`. */
  tripping: TrippingPolicy;
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

function newBucket(trippingFactory: () => TrippingPolicy): CircuitBucket {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    tripping: trippingFactory(),
    openedAt: 0,
    trial: null,
    reopenCount: 0,
    failuresByReason: new Map(),
    cooldownMsForOpen: 0,
  };
}

/** Key a bucket lookup falls into when the call omitted `model` under `isolateByModel`. */
const UNLABELED_MODEL = '';

/** Maps a call's `state` to the trial object it claimed a slot in, so a stale permit can be told apart from a current one. */
const trialPermits = new WeakMap<object, object>();

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
  /** Builds a fresh `TrippingPolicy` per bucket. */
  private readonly trippingFactory: () => TrippingPolicy;

  // Exactly one of these is used, chosen once at construction by `isolateByModel`.
  private readonly sharedBucket: CircuitBucket;
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
    this.trippingFactory = buildTrippingFactory(
      options.tripping ?? { kind: 'consecutive', threshold: this.threshold },
    );
    this.sharedBucket = newBucket(this.trippingFactory);
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

    if (bucket.state === 'half-open' && bucket.trial && this.claimsCurrentTrial(bucket, context)) {
      bucket.trial.successes += 1;
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't settle a trial it wasn't part of.
    if (bucket.state === 'half-open') return;

    bucket.consecutiveFailures = 0;
    bucket.tripping.onSuccess();
    bucket.trial = null;
    bucket.reopenCount = 0;
    bucket.failuresByReason.clear();
    this.transition(bucket, 'closed', model, context);

    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.bucketsByModel.delete(model ?? UNLABELED_MODEL);
    }
  }

  /** `code`, when present, is the failing `LLMError`'s `code`. Missing attributes to `'unknown'`. */
  recordFailure(model?: string, context?: CircuitBreakerCallContext, code?: LLMErrorCode): void {
    const bucket = this.ensureBucketFor(model);

    if (bucket.state === 'half-open' && bucket.trial && this.claimsCurrentTrial(bucket, context)) {
      bucket.trial.failures += 1;
      this.attributeFailure(bucket, code);
      this.settleTrialIfComplete(bucket, model, context);
      return;
    }

    // Stale trial permit: ignore, don't fall through to the closed-state counter below.
    if (bucket.state === 'half-open') return;

    bucket.consecutiveFailures += 1;
    this.attributeFailure(bucket, code);

    if (bucket.tripping.onFailure()) {
      bucket.openedAt = Date.now();
      bucket.cooldownMsForOpen = this.computeCooldown(bucket);
      this.transition(bucket, 'open', model, context);
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

    bucket.openedAt = Date.now();
    bucket.trial = null;
    bucket.cooldownMsForOpen = this.computeCooldown(bucket);
    this.transition(bucket, 'open', model, context);
  }

  /** Manually closes the circuit and resets its failure count, without requiring a real success first. */
  close(model?: string, context?: CircuitBreakerCallContext): void {
    const bucket = this.ensureBucketFor(model);

    bucket.consecutiveFailures = 0;
    bucket.tripping.reset();
    bucket.trial = null;
    bucket.reopenCount = 0;
    bucket.failuresByReason.clear();
    this.transition(bucket, 'closed', model, context);

    // transition() may have synchronously re-entered, so re-check state rather than assuming it still holds.
    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.bucketsByModel.delete(model ?? UNLABELED_MODEL);
    }
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

    const key = model ?? UNLABELED_MODEL;
    return this.bucketsByModel.get(key);
  }

  /** Creates and stores a bucket for a model when the first mutation needs one. */
  private ensureBucketFor(model: string | undefined): CircuitBucket {
    if (!this.isolateByModel) return this.sharedBucket;

    const key = model ?? UNLABELED_MODEL;
    let bucket = this.bucketsByModel.get(key);

    if (!bucket) {
      bucket = newBucket(this.trippingFactory);
      this.bucketsByModel.set(key, bucket);
    }

    return bucket;
  }

  /** True if this outcome's call claimed a permit for `bucket`'s current trial. */
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

  /** Records `code` (or `'unknown'` if omitted) against `bucket.failuresByReason`. */
  private attributeFailure(bucket: CircuitBucket, code: LLMErrorCode | undefined): void {
    const key = code ?? 'unknown';
    bucket.failuresByReason.set(key, (bucket.failuresByReason.get(key) ?? 0) + 1);
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
      bucket.tripping.onSuccess();
      bucket.reopenCount = 0;
      bucket.failuresByReason.clear();
      this.transition(bucket, 'closed', model, context);

      if (this.isolateByModel && bucket.state === 'closed') {
        this.bucketsByModel.delete(model ?? UNLABELED_MODEL);
      }
      return;
    }

    // Trial failed: reopen, reset the cooldown window, count the repeat.
    bucket.openedAt = Date.now();
    bucket.reopenCount += 1;
    bucket.cooldownMsForOpen = this.computeCooldown(bucket);
    this.transition(bucket, 'open', model, context);
  }
}
