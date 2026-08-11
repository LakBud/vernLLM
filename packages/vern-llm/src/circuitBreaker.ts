import { LLMError } from './types/errors.js';

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
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Mutable state for one circuit, either the single shared one or one model's bucket under `isolateByModel`. */
interface CircuitBucket {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  /**
   * True while a single half-open trial call is in flight. Guards against
   * multiple concurrent callers all treating themselves as "the" trial once
   * the cooldown elapses
   */
  trialInFlight: boolean;
}

function newBucket(): CircuitBucket {
  return { state: 'closed', consecutiveFailures: 0, openedAt: 0, trialInFlight: false };
}

/** Key a bucket lookup falls into when the call omitted `model` under `isolateByModel`. */
const UNLABELED_MODEL = '';

/**
 * Per retry VernLLM-instance circuit breaker. Tracks consecutive failures across
 * calls. Once the threshold is hit, short-circuits new calls with an
 * LLMError('circuit_open') instead of hitting the provider, until the
 * cooldown elapses and a single trial call is allowed through
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly onStateChange?: CircuitBreakerOptions['onStateChange'];
  private readonly isolateByModel: boolean;

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

  /** Every state mutation routes through here, so `onStateChange` fires exactly once per real change. */
  private transition(bucket: CircuitBucket, to: CircuitState, model: string | undefined): void {
    if (to === bucket.state) return;

    const from = bucket.state;
    bucket.state = to;
    this.onStateChange?.(from, to, bucket.consecutiveFailures, model);
  }

  /**
   * Throws if the circuit is open and the cooldown hasn't elapsed, or if
   * the circuit is half-open and a trial call is already in flight.
   * Otherwise, if the circuit just became eligible for a trial (cooldown
   * elapsed, or half-open with no trial currently running), this call
   * becomes that trial
   */
  assertClosed(model?: string): void {
    const bucket = this.ensureBucketFor(model);

    if (bucket.state === 'closed') return;

    if (bucket.state === 'open') {
      const elapsed = Date.now() - bucket.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new LLMError(
          `Circuit open, provider has failed ${bucket.consecutiveFailures} times in a row. Retry in ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s.`,
          'circuit_open',
        );
      }

      // Set before transition(): a synchronous onStateChange observer
      // that re-enters (e.g. calls assertClosed again) must see this
      // call as already claiming the trial, not still eligible for one.
      bucket.trialInFlight = true;
      this.transition(bucket, 'half-open', model);
      return;
    }

    // state === 'half-open'
    if (bucket.trialInFlight) {
      throw new LLMError(
        'Circuit half-open. A trial request is already in flight. Try again shortly.',
        'circuit_open',
      );
    }

    bucket.trialInFlight = true;
  }

  recordSuccess(model?: string): void {
    const bucket = this.lookupBucket(model);

    if (!bucket) {
      return;
    }

    bucket.consecutiveFailures = 0;
    bucket.trialInFlight = false;
    this.transition(bucket, 'closed', model);

    if (this.isolateByModel && bucket.state === 'closed' && bucket.consecutiveFailures === 0) {
      this.bucketsByModel.delete(model ?? UNLABELED_MODEL);
    }
  }

  recordFailure(model?: string): void {
    const bucket = this.ensureBucketFor(model);

    bucket.consecutiveFailures += 1;
    bucket.trialInFlight = false;

    if (bucket.state === 'half-open') {
      // Trial call failed: reopen and reset the cooldown window. Set
      // before transition() for the same reason as assertClosed above:
      // a synchronous observer must see the fresh cooldown, not a stale
      // or zeroed one.
      bucket.openedAt = Date.now();
      this.transition(bucket, 'open', model);
      return;
    }

    if (bucket.consecutiveFailures >= this.threshold) {
      bucket.openedAt = Date.now();
      this.transition(bucket, 'open', model);
    }
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
}
