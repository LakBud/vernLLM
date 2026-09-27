import { LLMError } from '../types/errors.js';
import { RollingRatio } from './rollingRatio.js';
import { validateMinCalls, validateRatio } from './utils/validate.utils.js';

/**
 * `windowMs` and `minCalls` work as in `RollingTripping`: `minCalls` keeps a cold start from
 * tripping. `retryRatio` is the largest share of calls in the window that may be retries. Invalid
 * values throw `RangeError` at construction.
 */
export interface RetryBudgetOptions {
  windowMs: number;
  minCalls: number;
  retryRatio: number;
}

/**
 * Caps the share of a target's recent traffic that may be retries. The breaker asks whether the
 * provider is healthy; this asks whether retrying is still worth the capacity it costs.
 */
export class RetryBudget {
  private readonly ratio: RollingRatio;

  constructor(private readonly options: RetryBudgetOptions) {
    this.ratio = new RollingRatio(options.windowMs);
    validateMinCalls(options.minCalls);
    validateRatio(options.retryRatio, 'retryRatio');
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
