import {
  assertNonNegativeFinite,
  assertPositiveFinite,
  invalidParams,
} from '../shared/errors/validate.utils.js';

import type {
  RedisCircuitBreakerOptions,
  RedisCooldownBackoff,
  RedisTrippingOption,
} from '../../circuitBreaker.js';

type RollingTripping = Extract<RedisTrippingOption, { kind: 'rolling' }>;

/** Options after defaults and validation. */
export interface ResolvedCircuitBreakerOptions {
  cooldownMs: number;
  isolateByModel: boolean;
  keyPrefix: string;
  channel: string;
  pollIntervalMs: number;
  probeLeaseMs: number;
  prepareTimeoutMs: number;
  halfOpenProbes: number;
  halfOpenSuccessRatio: number;
  backoff: RedisCooldownBackoff | undefined;
  /** Consecutive failures that open, or 0 with a rolling window. */
  threshold: number;
  rolling: RollingTripping | undefined;
}

/** Floors and clamps a finite number, else `fallback`. Never throws. */
function clampedInteger(value: number | undefined, min: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : fallback;
}

function clampedRatio(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function assertValidBackoff(backoff: RedisCooldownBackoff | undefined): void {
  if (backoff === undefined) return;

  if (typeof backoff === 'function') {
    invalidParams(
      'cooldownBackoff as a function is not supported by redisCircuitBreaker, use { multiplier, maxMs }. The growth is computed inside Redis.',
    );
  }
  if (!Number.isFinite(backoff.multiplier) || backoff.multiplier <= 0) {
    invalidParams(
      `cooldownBackoff.multiplier must be a finite number greater than 0 (got ${backoff.multiplier}).`,
    );
  }
  if (backoff.maxMs !== undefined && (Number.isNaN(backoff.maxMs) || backoff.maxMs <= 0)) {
    invalidParams(`cooldownBackoff.maxMs must be greater than 0 (got ${backoff.maxMs}).`);
  }
}

function assertValidRolling(tripping: RollingTripping): void {
  if (!Number.isFinite(tripping.windowMs) || tripping.windowMs <= 0) {
    invalidParams(
      `tripping.windowMs must be a finite number greater than 0 (got ${tripping.windowMs}).`,
    );
  }
  if (!Number.isInteger(tripping.minCalls) || tripping.minCalls < 0) {
    invalidParams(`tripping.minCalls must be a non-negative integer (got ${tripping.minCalls}).`);
  }
  if (
    !Number.isFinite(tripping.failureRatio) ||
    tripping.failureRatio < 0 ||
    tripping.failureRatio > 1
  ) {
    invalidParams(
      `tripping.failureRatio must be a finite number from 0 to 1 (got ${tripping.failureRatio}).`,
    );
  }
}

/** A threshold below 1, fractional or NaN matches no count of failures. */
function assertValidThreshold(name: string, threshold: number): void {
  if (!Number.isInteger(threshold) || threshold < 1) {
    invalidParams(`${name} must be an integer of at least 1 (got ${threshold}).`);
  }
}

/** Applies defaults and throws `LLMError('invalid_params')` on the first bad value. */
export function resolveCircuitBreakerOptions(
  options: RedisCircuitBreakerOptions,
): ResolvedCircuitBreakerOptions {
  const cooldownMs = options.cooldownMs ?? 30_000;
  const keyPrefix = options.keyPrefix ?? 'vernllm:cb';
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const probeLeaseMs = options.probeLeaseMs ?? 60_000;
  const prepareTimeoutMs = options.prepareTimeoutMs ?? 250;

  assertNonNegativeFinite('cooldownMs', cooldownMs);
  assertNonNegativeFinite('pollIntervalMs', pollIntervalMs);
  assertPositiveFinite('probeLeaseMs', probeLeaseMs);
  assertPositiveFinite('prepareTimeoutMs', prepareTimeoutMs);
  assertValidBackoff(options.cooldownBackoff);

  const tripping: RedisTrippingOption = options.tripping ?? {
    kind: 'consecutive',
    threshold: options.threshold ?? 5,
  };
  if (typeof tripping !== 'object' || !('kind' in tripping)) {
    invalidParams(
      'tripping must be { kind: "consecutive", threshold } or { kind: "rolling", ... }. A custom TrippingPolicy cannot run inside Redis.',
    );
  }
  if (tripping.kind === 'rolling') {
    assertValidRolling(tripping);
  } else if (tripping.kind === 'consecutive') {
    assertValidThreshold(options.tripping ? 'tripping.threshold' : 'threshold', tripping.threshold);
  } else {
    invalidParams(
      `tripping.kind must be "consecutive" or "rolling" (got ${String((tripping as { kind: unknown }).kind)}).`,
    );
  }

  return {
    cooldownMs,
    isolateByModel: options.isolateByModel ?? false,
    keyPrefix,
    channel: `${keyPrefix}:events`,
    pollIntervalMs,
    probeLeaseMs,
    prepareTimeoutMs,
    halfOpenProbes: clampedInteger(options.halfOpenProbes, 1, 1),
    halfOpenSuccessRatio: clampedRatio(options.halfOpenSuccessRatio),
    backoff: options.cooldownBackoff,
    threshold: tripping.kind === 'consecutive' ? tripping.threshold : 0,
    rolling: tripping.kind === 'rolling' ? tripping : undefined,
  };
}
