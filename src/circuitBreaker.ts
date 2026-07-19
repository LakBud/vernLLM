import { LLMError } from './types.js';

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

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  /** Throws if the circuit is open and the cooldown hasnt elapsed */
  assertClosed(): void {
    if (this.state !== 'open') return;

    const elapsed = Date.now() - this.openedAt;
    if (elapsed >= this.cooldownMs) {
      this.state = 'half-open';
      return;
    }

    throw new LLMError(
      `Circuit open — provider has failed ${this.consecutiveFailures} times in a row. Retry in ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s.`,
      'circuit_open',
    );
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;

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