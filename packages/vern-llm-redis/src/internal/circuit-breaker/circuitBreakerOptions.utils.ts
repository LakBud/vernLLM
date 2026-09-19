import { assertNonNegativeFinite, assertPositiveFinite, invalidParams } from '../validate.utils.js';

import type {
  RedisCircuitBreakerOptions,
  RedisCooldownBackoff,
  RedisTrippingOption,
} from '../../circuitBreaker.js';

type RollingTripping = Extract<RedisTrippingOption, { kind: 'rolling' }>;

/** `redisCircuitBreaker`'s options after defaults are applied and every value is checked. */
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
  /** The consecutive failure count that opens the circuit, or 0 when a rolling window decides instead. */
  threshold: number;
  rolling: RollingTripping | undefined;
}

/** Finite numbers are floored and clamped, anything else falls back to `fallback`. Never throws: these two options are clamped, not rejected. */
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

/**
 * Rolling window mistakes throw `RangeError`, not `LLMError`, on purpose:
 * core's own CircuitBreaker throws the same for the same mistakes, and the
 * two are meant to be interchangeable. It is a construction time config
 * mistake, caught once, never something a running call can hit.
 */
function assertValidRolling(tripping: RollingTripping): void {
  if (!Number.isFinite(tripping.windowMs) || tripping.windowMs <= 0) {
    throw new RangeError(`tripping.windowMs must be a finite number > 0, got ${tripping.windowMs}`);
  }
  if (!Number.isInteger(tripping.minCalls) || tripping.minCalls < 0) {
    throw new RangeError(
      `tripping.minCalls must be a non-negative integer, got ${tripping.minCalls}`,
    );
  }
  if (
    !Number.isFinite(tripping.failureRatio) ||
    tripping.failureRatio < 0 ||
    tripping.failureRatio > 1
  ) {
    throw new RangeError(
      `tripping.failureRatio must be finite and within [0, 1], got ${tripping.failureRatio}`,
    );
  }
}

/** Applies defaults and throws `LLMError('invalid_params')` (or `RangeError` for a bad rolling window) on the first bad value. */
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
  // `null` never gets here: `??` above already turned it into the default.
  if (typeof tripping !== 'object' || !('kind' in tripping)) {
    invalidParams(
      'tripping must be { kind: "consecutive", threshold } or { kind: "rolling", ... }. A custom TrippingPolicy cannot run inside Redis.',
    );
  }
  if (tripping.kind === 'rolling') assertValidRolling(tripping);

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
