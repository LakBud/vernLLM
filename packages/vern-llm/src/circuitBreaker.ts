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
   * of `assertClosed`/`recordSuccess`/`recordFailure` caused it), not a
   * property of the circuit itself: the breaker still counts failures
   * across every model together, so a threshold crossing can be the sum
   * of several different models' failures even though only the last
   * one's `model` is reported here.
   */
  onStateChange?: (
    from: CircuitState,
    to: CircuitState,
    consecutiveFailures: number,
    model?: string,
  ) => void;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Per retry VernLLM-instance circuit breaker. Tracks consecutive failures across
 * calls. Once the threshold is hit, short-circuits new calls with an
 * LLMError('circuit_open') instead of hitting the provider, until the
 * cooldown elapses and a single trial call is allowed through
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private threshold: number;
  private cooldownMs: number;
  /**
   * True while a single half-open trial call is in flight. Guards against
   * multiple concurrent callers all treating themselves as "the" trial once
   * the cooldown elapses
   */
  private trialInFlight = false;
  private readonly onStateChange?: CircuitBreakerOptions['onStateChange'];
  /** Model of the call that most recently touched the breaker, reported alongside the next state change. */
  private lastModel: string | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.onStateChange = options.onStateChange;
  }

  /** Every state mutation routes through here, so `onStateChange` fires exactly once per real change. */
  private transition(to: CircuitState): void {
    if (to === this.state) return;

    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to, this.consecutiveFailures, this.lastModel);
  }

  /**
   * Throws if the circuit is open and the cooldown hasn't elapsed, or if
   * the circuit is half-open and a trial call is already in flight.
   * Otherwise, if the circuit just became eligible for a trial (cooldown
   * elapsed, or half-open with no trial currently running), this call
   * becomes that trial
   */
  assertClosed(model?: string): void {
    this.lastModel = model;

    if (this.state === 'closed') return;

    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new LLMError(
          `Circuit open, provider has failed ${this.consecutiveFailures} times in a row. Retry in ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s.`,
          'circuit_open',
        );
      }

      this.transition('half-open');
      this.trialInFlight = true;
      return;
    }

    // state === 'half-open'
    if (this.trialInFlight) {
      throw new LLMError(
        'Circuit half-open. A trial request is already in flight. Try again shortly.',
        'circuit_open',
      );
    }

    this.trialInFlight = true;
  }

  recordSuccess(model?: string): void {
    this.lastModel = model;
    this.consecutiveFailures = 0;
    this.transition('closed');
    this.trialInFlight = false;
  }

  recordFailure(model?: string): void {
    this.lastModel = model;
    this.consecutiveFailures += 1;
    this.trialInFlight = false;

    if (this.state === 'half-open') {
      // Trial call failed: reopen and reset the cooldown window.
      this.transition('open');
      this.openedAt = Date.now();
      return;
    }

    if (this.consecutiveFailures >= this.threshold) {
      this.transition('open');
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}
