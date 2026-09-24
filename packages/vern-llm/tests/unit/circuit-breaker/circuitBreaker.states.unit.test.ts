import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../src/circuitBreaker.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CircuitBreaker, state transitions (unit)', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('opens after `threshold` consecutive failures', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('behaves exactly as before when recordFailure is called with no third argument', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.recordFailure(undefined, undefined);
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(undefined, undefined);
    expect(cb.getState()).toBe('open');
  });

  it('accepts an optional code argument without throwing or changing trip behavior', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    expect(() => cb.recordFailure(undefined, undefined, 'server_error')).not.toThrow();
    cb.recordFailure(undefined, undefined, 'server_error');
    expect(cb.getState()).toBe('open');
  });

  it('throws LLMError(circuit_open) while open and within cooldown', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
    cb.recordFailure();
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));
  });

  it('resets consecutive failures on success', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed'); // only 1 consecutive failure since reset
  });

  it('transitions to half-open after cooldown elapses, and closes on a successful trial', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(1001);
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('reopens if the half-open trial call fails', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    cb.assertClosed(); // -> half-open
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('rejects concurrent callers during half-open, letting only the first through as the trial', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);

    // First caller becomes the trial and is allowed through
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    // Every other concurrent caller is rejected while the trial is outstanding
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));
  });

  it('allows a new trial once the outstanding half-open trial is recorded (success)', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);

    cb.assertClosed(); // trial 1 starts
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' })); // blocked while trial 1 is in flight

    cb.recordSuccess(); // trial 1 resolves, circuit closes
    expect(() => cb.assertClosed()).not.toThrow(); // closed circuit, no gating needed
  });

  it('allows a new trial once the outstanding half-open trial is recorded (failure)', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);

    cb.assertClosed(); // trial 1 starts
    expect(() => cb.assertClosed()).toThrow(); // blocked while trial 1 is in flight

    cb.recordFailure(); // trial 1 fails, circuit reopens with a fresh cooldown
    expect(cb.getState()).toBe('open');
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));

    vi.advanceTimersByTime(1001);
    expect(() => cb.assertClosed()).not.toThrow(); // new cooldown elapsed, new trial allowed
    expect(cb.getState()).toBe('half-open');
  });
});

describe('CircuitBreaker, onStateChange model label (unit)', () => {
  it('reports the model passed to the call that triggered a transition, via onStateChange', () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure('gpt-4o');

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 1, 'gpt-4o', undefined);
  });

  it('reports whichever model most recently touched the breaker, even across different models', () => {
    // The breaker's failure count stays shared across every model; only
    // the *label* on the emitted transition reflects the triggering call.
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, onStateChange });

    cb.recordFailure('gpt-4o'); // 1st failure, no transition yet
    cb.recordFailure('gpt-4o-mini'); // 2nd failure, crosses threshold

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 2, 'gpt-4o-mini', undefined);
  });

  it('omitting `model` on record/assert calls reports undefined, not a stale prior value', () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure();
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 1, undefined, undefined);

    // Also cover assertClosed's own transition (open -> half-open),
    // the test's title mentions "assert calls" but only recordFailure
    // was previously exercised.
    vi.advanceTimersByTime(1001);
    cb.assertClosed();
    expect(onStateChange).toHaveBeenCalledWith('open', 'half-open', 1, undefined, undefined);
  });
});
