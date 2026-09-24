import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../src/circuitBreaker.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CircuitBreaker, cooldown backoff (unit)', () => {
  it('no cooldownBackoff reproduces the current fixed cooldown, unmodified', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    // Reopen via a failed trial, cooldown should still be the same
    // fixed 1000ms, not grown, since no cooldownBackoff is configured.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('the shorthand jitters only the growth above cooldownMs: falls in [base, exp]', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2 },
    });

    // First open: reopenCount 0, exp = 1000 = base, so nothing to jitter.
    cb.recordFailure();
    vi.advanceTimersByTime(1000);
    cb.assertClosed();

    // Trial fails: reopenCount 1, exp = 2000, 1000 + 0.3 * 1000 = 1300ms.
    cb.recordFailure();
    vi.advanceTimersByTime(1299);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');
  });

  it('the first cooldown never drops below cooldownMs, even at the lowest jitter draw', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2 },
    });

    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    expect(() => cb.assertClosed()).not.toThrow();

    // Repeat opens keep the same floor.
    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
  });

  it('a maxMs below cooldownMs lowers the floor with it, so the cap still holds', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2, maxMs: 400 },
    });

    cb.recordFailure();
    vi.advanceTimersByTime(399);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('the jittered cooldown is sampled once per open period, not resampled on every assertClosed check', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 10_000,
      cooldownBackoff: { multiplier: 2 },
    });

    // Reach reopenCount 1, where there's a range to jitter over.
    cb.recordFailure();
    vi.advanceTimersByTime(10_000);
    cb.assertClosed();
    cb.recordFailure();

    const messages: string[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        cb.assertClosed();
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    // The jitter range spans [10000, 20000]ms, so resampling per check
    // would very likely change the reported "Retry in Xs" across 20 draws.
    expect(messages).toHaveLength(20);
    expect(new Set(messages).size).toBe(1);
  });

  it('a custom function is never jittered automatically, jitter only applies to the shorthand', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: () => 1000, // fixed, no jitter applied by the library
    });

    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('the { multiplier, maxMs } shorthand grows the jittered range across three reopen cycles', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2 },
    });

    // reopenCount 0: exp = 1000 = base, exactly 1000ms.
    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');

    // reopenCount 1: exp = 2000, 1000 + 0.5 * 1000 = 1500ms.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(1499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');

    // reopenCount 2: exp = 4000, 1000 + 0.5 * 3000 = 2500ms.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(2499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');
  });

  it('maxMs caps the growth, including the jittered range', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 10, maxMs: 5000 },
    });

    cb.recordFailure();
    vi.advanceTimersByTime(1000);
    cb.assertClosed();

    // reopenCount 1: uncapped exp 10000, capped to 5000, 1000 + 0.5 * 4000 = 3000ms.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(2999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('a custom linear backoff function, passed directly rather than the shorthand, is honored exactly', () => {
    vi.useFakeTimers();
    const linear = (reopenCount: number, baseCooldownMs: number): number =>
      baseCooldownMs + reopenCount * 500;
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, cooldownBackoff: linear });

    // First open: reopenCount 0, cooldown 1000 + 0 * 500 = 1000.
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    cb.assertClosed();

    // Trial fails: reopenCount 1, cooldown 1000 + 1 * 500 = 1500.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(1499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('a backoff function returning a negative number is clamped to 0', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: () => -500,
    });

    cb.recordFailure();
    // A 0ms cooldown is already elapsed, so getState reports trial-ready.
    expect(cb.getState()).toBe('half-open');
    // Clamped to 0: no wait at all, admits a trial immediately.
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');
  });

  it('treats a NaN cooldownBackoff result as a zero-length cooldown', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: () => Number.NaN,
    });

    cb.recordFailure();
    // A NaN backoff result is clamped to 0, so the circuit should already
    // be eligible to move to half-open with no time advanced at all.
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('recordSuccess resets reopenCount, so a later reopen starts the backoff over', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2 },
    });

    // Open, reopen once via a failed trial (reopenCount 1, 1500ms), then
    // recover with a successful trial, which resets reopenCount.
    cb.recordFailure();
    vi.advanceTimersByTime(1000);
    cb.assertClosed();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(1500);
    cb.assertClosed();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');

    // Trip again: back to reopenCount 0, so 1000ms, not 1500ms or more.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    expect(() => cb.assertClosed()).not.toThrow();
  });
});
