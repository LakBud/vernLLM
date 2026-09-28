import { LLMError } from 'vern-llm';

/** Minimum gap between AIMD shrinks, core's value, across every process. */
export const AIMD_SHRINK_WINDOW_MS = 60_000;

export interface AimdOptions {
  /** Added to the ceiling on each successful release. */
  increaseBy: number;
  /** Multiplies the ceiling on a rate limit signal, in (0, 1]. */
  decreaseFactor: number;
  /** Lowest ceiling. */
  minCapacity: number;
  /** Highest ceiling. */
  maxCapacity: number;
  /** Shrinks early once a hint's remainingRequests is at or below this. Default 0, off. */
  proactiveFloor?: number;
}

/** Throws `LLMError('invalid_params')` for an unusable AIMD config. */
export function assertValidAimd(aimd: AimdOptions, requestsPerMinute: number | undefined): void {
  if (!requestsPerMinute) {
    throw new LLMError('aimd requires requestsPerMinute to be set.', 'invalid_params');
  }
  for (const name of ['minCapacity', 'maxCapacity'] as const) {
    if (!Number.isFinite(aimd[name])) {
      throw new LLMError(`aimd.${name} (${aimd[name]}) must be a finite number.`, 'invalid_params');
    }
  }
  if (aimd.minCapacity < 1 || aimd.maxCapacity < 1) {
    throw new LLMError(
      `aimd.minCapacity (${aimd.minCapacity}) and aimd.maxCapacity (${aimd.maxCapacity}) must both be at least 1, since the requests bucket always takes 1 per acquire; a capacity below 1 could never be satisfied.`,
      'invalid_params',
    );
  }
  if (aimd.minCapacity > aimd.maxCapacity) {
    throw new LLMError(
      `aimd.minCapacity (${aimd.minCapacity}) must not exceed aimd.maxCapacity (${aimd.maxCapacity}).`,
      'invalid_params',
    );
  }
  if (!Number.isFinite(aimd.increaseBy) || aimd.increaseBy <= 0) {
    throw new LLMError('aimd.increaseBy must be a finite number greater than 0.', 'invalid_params');
  }
  if (
    !Number.isFinite(aimd.decreaseFactor) ||
    aimd.decreaseFactor <= 0 ||
    aimd.decreaseFactor > 1
  ) {
    throw new LLMError(
      'aimd.decreaseFactor must be a finite number greater than 0 and at most 1.',
      'invalid_params',
    );
  }
  if (
    aimd.proactiveFloor !== undefined &&
    (!Number.isFinite(aimd.proactiveFloor) || aimd.proactiveFloor < 0)
  ) {
    throw new LLMError(
      `aimd.proactiveFloor (${aimd.proactiveFloor}) must be a finite number that is not negative.`,
      'invalid_params',
    );
  }
}
