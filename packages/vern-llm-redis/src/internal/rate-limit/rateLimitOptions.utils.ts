import { defaultEstimateTokens, LLMError, type WireRequest } from 'vern-llm';

import { assertPositiveFinite, invalidParams } from '../shared/errors/validate.utils.js';
import { assertValidAimd, type AimdOptions } from './aimd.utils.js';

import type { RedisRateLimitOptions } from '../../rateLimit.js';

/** Options after defaults and validation. */
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

/** `estimateFraction` must be finite and above 0. Above 1 is clamped. Same as core. */
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

/** Longest delay a timer can hold. Past it, a wait would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Core's limit rules and messages. A ceiling in (0, 1) could never be met. */
function assertValidLimits(options: RedisRateLimitOptions, maxQueueMs: number): void {
  for (const name of ['requestsPerMinute', 'tokensPerMinute'] as const) {
    const value = options[name];
    if (value === undefined || value === 0) continue;

    if (!Number.isFinite(value) || value < 1) {
      invalidParams(`${name} (${value}) must be 0 (unlimited) or a finite number of at least 1.`);
    }
  }

  // A fractional slot count can't describe calls in flight.
  for (const name of ['maxConcurrent', 'maxQueueSize'] as const) {
    const value = options[name];
    if (value === undefined) continue;

    if (!Number.isInteger(value) || value < 0) {
      invalidParams(`${name} (${value}) must be a non-negative integer (0 means unlimited).`);
    }
  }

  if (!Number.isFinite(maxQueueMs) || maxQueueMs < 0 || maxQueueMs > MAX_TIMER_MS) {
    invalidParams(
      `maxQueueMs (${maxQueueMs}) must be a finite number from 0 to ${MAX_TIMER_MS}. Pass 0 to wait indefinitely.`,
    );
  }
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

  assertValidLimits(options, maxQueueMs);
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
