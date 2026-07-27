import { LLMError } from './types/errors.js';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens, default 5 */
  threshold?: number;
  /** How long the circuit stays open before allowing a trial request, in ms. Default 30000 */
  cooldownMs?: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

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

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  /**
   * Throws if the circuit is open and the cooldown hasn't elapsed, or if
   * the circuit is half-open and a trial call is already in flight.
   * Otherwise, if the circuit just became eligible for a trial (cooldown
   * elapsed, or half-open with no trial currently running), this call
   * becomes that trial
   */
  assertClosed(): void {
    if (this.state === 'closed') return;

    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new LLMError(
          `Circuit open — provider has failed ${this.consecutiveFailures} times in a row. Retry in ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s.`,
          'circuit_open',
        );
      }

      this.state = 'half-open';
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

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.trialInFlight = false;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.trialInFlight = false;

    if (this.state === 'half-open') {
      // Trial call failed: reopen and reset the cooldown window.
      this.state = 'open';
      this.openedAt = Date.now();
      return;
    }

    if (this.consecutiveFailures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}
