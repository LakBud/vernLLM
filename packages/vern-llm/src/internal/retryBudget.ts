import { LLMError } from '../types/errors.js';
import { RollingRatio } from './rollingRatio.js';

/**
 * Tunables for a `RetryBudget`. `windowMs`/`minCalls` behave the same as
 * `RollingTripping`'s (see `circuitBreaker.ts`): `minCalls` gates the
 * check so a cold start with too little traffic to judge doesn't trip.
 * `retryRatio` is the max fraction of calls in the window allowed to be
 * retries before the budget stops allowing more.
 */
export interface RetryBudgetOptions {
  windowMs: number;
  minCalls: number;
  retryRatio: number;
}

/**
 * Caps how much of a target's recent traffic is allowed to be retries,
 * independent of the circuit breaker. The breaker asks whether the
 * provider is healthy; this asks whether retrying is still worth the
 * capacity it costs, regardless of provider health. Reuses `RollingRatio`,
 * the same primitive `RollingTripping` is built on, rather than a second
 * hand rolled window.
 */
export class RetryBudget {
  private readonly ratio: RollingRatio;

  constructor(private readonly options: RetryBudgetOptions) {
    this.ratio = new RollingRatio(options.windowMs);
  }

  /**
   * Throws `LLMError('retry_budget_exhausted')` once at least `minCalls`
   * calls have landed in the trailing `windowMs` and the retry ratio
   * among them has reached `retryRatio`. A no-op otherwise.
   */
  assertAvailable(): void {
    if (
      this.ratio.getCount() >= this.options.minCalls &&
      this.ratio.getRatio() >= this.options.retryRatio
    ) {
      throw new LLMError('Retry budget exhausted', 'rate_limited', {
        code: 'retry_budget_exhausted',
      });
    }
  }

  /** Records one attempt. `isRetry` is false for a call's first attempt, true for every attempt after it. */
  recordAttempt(isRetry: boolean): void {
    this.ratio.record(isRetry);
  }

  /** Current traffic and retry ratio in the trailing window. */
  getSnapshot(): { attempts: number; retryRatio: number } {
    return { attempts: this.ratio.getCount(), retryRatio: this.ratio.getRatio() };
  }
}
