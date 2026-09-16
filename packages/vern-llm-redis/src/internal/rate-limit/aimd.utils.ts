import { LLMError } from 'vern-llm';

export interface AimdOptions {
  /** Added to the requests-per-minute ceiling on every recorded successful release. */
  increaseBy: number;
  /** Multiplied against the ceiling on a rate-limit signal. Must be greater than 0 and at most 1. */
  decreaseFactor: number;
  /** Floor the ceiling never shrinks below. */
  minCapacity: number;
  /** Ceiling the ceiling never grows above. */
  maxCapacity: number;
  /** Shrink proactively once a provider hint reports remainingRequests at or below this. Default 0, meaning off. */
  proactiveFloor?: number;
}

/** Throws LLMError('invalid_params') describing what's wrong, or returns normally when aimd is a usable config. */
export function assertValidAimd(aimd: AimdOptions, requestsPerMinute: number | undefined): void {
  if (!requestsPerMinute) {
    throw new LLMError('aimd requires requestsPerMinute to be set.', 'invalid_params');
  }
  if (aimd.minCapacity < 1 || aimd.maxCapacity < 1) {
    throw new LLMError(
      'aimd.minCapacity and aimd.maxCapacity must both be at least 1.',
      'invalid_params',
    );
  }
  if (aimd.minCapacity > aimd.maxCapacity) {
    throw new LLMError('aimd.minCapacity must not exceed aimd.maxCapacity.', 'invalid_params');
  }
  if (aimd.decreaseFactor <= 0 || aimd.decreaseFactor > 1) {
    throw new LLMError(
      'aimd.decreaseFactor must be greater than 0 and at most 1.',
      'invalid_params',
    );
  }
}
