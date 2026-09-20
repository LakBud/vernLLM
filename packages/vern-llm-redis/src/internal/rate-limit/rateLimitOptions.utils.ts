import { defaultEstimateTokens, LLMError, type WireRequest } from 'vern-llm';

import {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveFinite,
} from '../validate.utils.js';
import { assertValidAimd, type AimdOptions } from './aimd.utils.js';

import type { RedisRateLimitOptions } from '../../rateLimit.js';

/** `redisRateLimit`'s options after defaults are applied and every value is checked. */
export interface ResolvedRateLimitOptions {
  keyPrefix: string;
  wakeChannel: string;
  queueKey: string;
  maxQueueMs: number;
  maxQueueSize: number;
  pollIntervalMs: number;
  concurrencyLeaseMs: number;
  queueLeaseMs: number;
  fairQueue: boolean;
  estimateFraction: number;
  estimateTokens: (request: WireRequest) => number;
  aimd: AimdOptions | undefined;
}

/** Validates `estimateFraction`. Non finite or `<= 0` would zero out or invert the reservation, so it throws; above `1` is only wasteful, so it's clamped. Same rule as core's. */
function resolveEstimateFraction(fraction: number | undefined): number {
  if (fraction === undefined) return 1;

  if (!Number.isFinite(fraction) || fraction <= 0) {
    throw new LLMError(
      `estimateFraction (${fraction}) must be a finite number greater than 0.`,
      'invalid_params',
    );
  }

  return Math.min(fraction, 1);
}

/** Applies defaults and throws `LLMError('invalid_params')` on the first bad value. */
export function resolveRateLimitOptions(options: RedisRateLimitOptions): ResolvedRateLimitOptions {
  const keyPrefix = options.keyPrefix ?? 'vernllm:rl';
  const maxQueueMs = options.maxQueueMs ?? 30_000;
  const maxQueueSize = options.maxQueueSize ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const concurrencyLeaseMs = options.concurrencyLeaseMs ?? 30_000;
  const queueLeaseMs = options.queueLeaseMs ?? 15_000;
  const estimateFraction = resolveEstimateFraction(options.estimateFraction);

  // 0 is meaningful (unlimited capacity for the three bucket options,
  // "wait forever" for maxQueueMs) and must be preserved, not rejected.
  // Only negative or non-finite values are actual config mistakes.
  assertNonNegativeFinite('requestsPerMinute', options.requestsPerMinute);
  assertNonNegativeFinite('tokensPerMinute', options.tokensPerMinute);
  assertNonNegativeFinite('maxConcurrent', options.maxConcurrent);
  assertNonNegativeFinite('maxQueueMs', maxQueueMs);
  assertNonNegativeInteger('maxQueueSize', maxQueueSize);
  assertPositiveFinite('queueLeaseMs', queueLeaseMs);
  assertPositiveFinite('concurrencyLeaseMs', concurrencyLeaseMs);
  assertPositiveFinite('pollIntervalMs', pollIntervalMs);

  if (options.aimd) assertValidAimd(options.aimd, options.requestsPerMinute);

  return {
    keyPrefix,
    wakeChannel: `${keyPrefix}:wake`,
    queueKey: `${keyPrefix}:queue`,
    maxQueueMs,
    maxQueueSize,
    pollIntervalMs,
    concurrencyLeaseMs,
    queueLeaseMs,
    fairQueue: options.fairQueue ?? true,
    estimateFraction,
    estimateTokens: options.estimateTokens ?? defaultEstimateTokens,
    aimd: options.aimd,
  };
}
