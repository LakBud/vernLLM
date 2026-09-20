import { describe, expect, it } from 'vitest';

import { resolveCircuitBreakerOptions } from '../../../../src/internal/circuit-breaker/circuitBreakerOptions.utils.js';

describe('resolveCircuitBreakerOptions defaults', () => {
  it('fills every default', () => {
    expect(resolveCircuitBreakerOptions({})).toEqual({
      cooldownMs: 30_000,
      isolateByModel: false,
      keyPrefix: 'vernllm:cb',
      channel: 'vernllm:cb:events',
      pollIntervalMs: 5_000,
      probeLeaseMs: 60_000,
      prepareTimeoutMs: 250,
      halfOpenProbes: 1,
      halfOpenSuccessRatio: 1,
      backoff: undefined,
      threshold: 5,
      rolling: undefined,
    });
  });

  it('derives the channel from a custom key prefix', () => {
    expect(resolveCircuitBreakerOptions({ keyPrefix: 'app:cb' }).channel).toBe('app:cb:events');
  });

  it('uses `threshold` for consecutive tripping, and `tripping` over it when both are set', () => {
    expect(resolveCircuitBreakerOptions({ threshold: 2 }).threshold).toBe(2);
    expect(
      resolveCircuitBreakerOptions({
        threshold: 2,
        tripping: { kind: 'consecutive', threshold: 9 },
      }).threshold,
    ).toBe(9);
  });

  it('reports threshold 0 and the window when rolling tripping is set', () => {
    const rolling = { kind: 'rolling', windowMs: 1000, minCalls: 4, failureRatio: 0.5 } as const;
    const resolved = resolveCircuitBreakerOptions({ tripping: rolling });

    expect(resolved.threshold).toBe(0);
    expect(resolved.rolling).toBe(rolling);
  });

  it('passes a valid cooldown backoff through', () => {
    const backoff = { multiplier: 2, maxMs: 60_000 };
    expect(resolveCircuitBreakerOptions({ cooldownBackoff: backoff }).backoff).toBe(backoff);
  });
});

describe('resolveCircuitBreakerOptions clamping', () => {
  it('floors halfOpenProbes and clamps it to at least 1', () => {
    expect(resolveCircuitBreakerOptions({ halfOpenProbes: 3.9 }).halfOpenProbes).toBe(3);
    expect(resolveCircuitBreakerOptions({ halfOpenProbes: 0 }).halfOpenProbes).toBe(1);
    expect(resolveCircuitBreakerOptions({ halfOpenProbes: -4 }).halfOpenProbes).toBe(1);
  });

  it('falls back to 1 probe for a non finite value instead of throwing', () => {
    expect(resolveCircuitBreakerOptions({ halfOpenProbes: Number.NaN }).halfOpenProbes).toBe(1);
    expect(resolveCircuitBreakerOptions({ halfOpenProbes: Infinity }).halfOpenProbes).toBe(1);
  });

  it('clamps halfOpenSuccessRatio into [0, 1]', () => {
    expect(resolveCircuitBreakerOptions({ halfOpenSuccessRatio: 0.5 }).halfOpenSuccessRatio).toBe(
      0.5,
    );
    expect(resolveCircuitBreakerOptions({ halfOpenSuccessRatio: 7 }).halfOpenSuccessRatio).toBe(1);
    expect(resolveCircuitBreakerOptions({ halfOpenSuccessRatio: -1 }).halfOpenSuccessRatio).toBe(0);
  });

  it('falls back to 1 for a non finite success ratio instead of throwing', () => {
    expect(
      resolveCircuitBreakerOptions({ halfOpenSuccessRatio: Number.NaN }).halfOpenSuccessRatio,
    ).toBe(1);
  });
});

describe('resolveCircuitBreakerOptions validation', () => {
  it.each([
    [{ cooldownMs: -1 }, 'cooldownMs must be a finite number that is not negative (got -1).'],
    [
      { pollIntervalMs: Infinity },
      'pollIntervalMs must be a finite number that is not negative (got Infinity).',
    ],
    [{ probeLeaseMs: 0 }, 'probeLeaseMs must be a finite number greater than 0 (got 0).'],
    [
      { prepareTimeoutMs: Number.NaN },
      'prepareTimeoutMs must be a finite number greater than 0 (got NaN).',
    ],
  ])('rejects %j as invalid_params', (options, message) => {
    expect(() => resolveCircuitBreakerOptions(options)).toThrow(
      expect.objectContaining({ type: 'invalid_params', message }),
    );
  });

  it('accepts 0 for cooldownMs and pollIntervalMs, which mean no wait and no polling', () => {
    expect(() => resolveCircuitBreakerOptions({ cooldownMs: 0, pollIntervalMs: 0 })).not.toThrow();
  });

  it('rejects a function cooldownBackoff, since growth is computed inside Redis', () => {
    const options = { cooldownBackoff: (() => 1) as never };
    expect(() => resolveCircuitBreakerOptions(options)).toThrow(/cooldownBackoff as a function/);
  });

  it.each([
    [
      { multiplier: 0 },
      'cooldownBackoff.multiplier must be a finite number greater than 0 (got 0).',
    ],
    [
      { multiplier: Infinity },
      'cooldownBackoff.multiplier must be a finite number greater than 0 (got Infinity).',
    ],
    [{ multiplier: 2, maxMs: 0 }, 'cooldownBackoff.maxMs must be greater than 0 (got 0).'],
    [
      { multiplier: 2, maxMs: Number.NaN },
      'cooldownBackoff.maxMs must be greater than 0 (got NaN).',
    ],
  ])('rejects cooldownBackoff %j', (cooldownBackoff, message) => {
    expect(() => resolveCircuitBreakerOptions({ cooldownBackoff })).toThrow(
      expect.objectContaining({ type: 'invalid_params', message }),
    );
  });

  it('accepts an unbounded maxMs of Infinity', () => {
    expect(() =>
      resolveCircuitBreakerOptions({ cooldownBackoff: { multiplier: 2, maxMs: Infinity } }),
    ).not.toThrow();
  });

  it.each([5, 'rolling', {}])('rejects tripping %j, which is not a kind object', (tripping) => {
    expect(() => resolveCircuitBreakerOptions({ tripping: tripping as never })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws RangeError for a bad rolling window, matching core', () => {
    const rolling = (over: object) =>
      resolveCircuitBreakerOptions({
        tripping: { kind: 'rolling', windowMs: 1000, minCalls: 1, failureRatio: 0.5, ...over },
      });

    expect(() => rolling({ windowMs: 0 })).toThrow(RangeError);
    expect(() => rolling({ windowMs: Infinity })).toThrow(RangeError);
    expect(() => rolling({ minCalls: -1 })).toThrow(RangeError);
    expect(() => rolling({ minCalls: 1.5 })).toThrow(RangeError);
    expect(() => rolling({ failureRatio: 2 })).toThrow(RangeError);
    expect(() => rolling({ failureRatio: -0.1 })).toThrow(RangeError);
    expect(() => rolling({ failureRatio: Number.NaN })).toThrow(RangeError);
  });

  it('treats a null tripping as unset and falls back to the default', () => {
    expect(resolveCircuitBreakerOptions({ tripping: null as never }).threshold).toBe(5);
  });

  it('accepts the edges of a rolling window', () => {
    expect(() =>
      resolveCircuitBreakerOptions({
        tripping: { kind: 'rolling', windowMs: 1, minCalls: 0, failureRatio: 1 },
      }),
    ).not.toThrow();
  });
});
