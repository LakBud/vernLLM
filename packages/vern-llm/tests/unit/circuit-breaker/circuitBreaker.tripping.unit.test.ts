import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CircuitBreaker,
  ConsecutiveTripping,
  RollingTripping,
  type TrippingPolicy,
} from '../../../src/circuitBreaker.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CircuitBreaker, tripping policy (unit)', () => {
  it('default tripping (no option) reproduces the current consecutive-failure suite unmodified', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it("the `{ kind: 'consecutive' }` shorthand behaves identically to a hand built ConsecutiveTripping", () => {
    const shorthand = new CircuitBreaker({
      cooldownMs: 1000,
      tripping: { kind: 'consecutive', threshold: 2 },
    });
    const handBuilt = new CircuitBreaker({
      cooldownMs: 1000,
      tripping: new ConsecutiveTripping(2),
    });

    shorthand.recordFailure();
    handBuilt.recordFailure();
    expect(shorthand.getState()).toBe('closed');
    expect(handBuilt.getState()).toBe('closed');

    shorthand.recordFailure();
    handBuilt.recordFailure();
    expect(shorthand.getState()).toBe('open');
    expect(handBuilt.getState()).toBe('open');
  });

  it("`{ kind: 'rolling' }` trips exactly at the configured ratio and not before", () => {
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 4, failureRatio: 0.5 },
    });

    cb.recordFailure(); // 1/1, below minCalls
    expect(cb.getState()).toBe('closed');
    cb.recordSuccess(); // 1/2
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(); // 2/3, still below minCalls
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(); // 3/4, minCalls met, ratio 0.75 >= 0.5
    expect(cb.getState()).toBe('open');
  });

  it('rolling tripping still trips under isolateByModel when successes are interleaved', () => {
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      isolateByModel: true,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 4, failureRatio: 0.5 },
    });

    cb.assertClosed('gpt');
    cb.recordFailure('gpt'); // 1/1
    cb.recordSuccess('gpt'); // 1/2, bucket dropped, window kept
    cb.recordFailure('gpt'); // 2/3
    expect(cb.getState('gpt')).toBe('closed');
    cb.recordFailure('gpt'); // 3/4, ratio 0.75
    expect(cb.getState('gpt')).toBe('open');
  });

  it('a success does not call tripping.forget under isolateByModel', () => {
    const forget = vi.fn();
    const custom: TrippingPolicy = {
      onSuccess: () => {},
      onFailure: () => false,
      reset: () => {},
      forget,
    };
    const cb = new CircuitBreaker({ cooldownMs: 1000, isolateByModel: true, tripping: custom });

    cb.assertClosed('gpt');
    cb.recordSuccess('gpt');
    expect(forget).not.toHaveBeenCalled();

    cb.close('gpt');
    expect(forget).toHaveBeenCalledWith('gpt');
  });

  it('lets a RollingTripping policy release a discarded model bucket (isolateByModel)', () => {
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      isolateByModel: true,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 1, failureRatio: 0.5 },
    });

    // assertClosed allocates the bucket (recordSuccess alone is a no-op
    // for a model with no bucket yet). Then a success on that fresh,
    // still-closed, zero-consecutive-failures bucket discards it,
    // while RollingTripping keeps its window.
    cb.assertClosed('gpt');
    cb.recordSuccess('gpt');

    expect(cb.getState('gpt')).toBe('closed');
    expect(cb.getFailureBreakdown('gpt')).toEqual({});
  });

  it('RollingTripping.forget clears the failure window when close() resets a model (isolateByModel)', () => {
    const tripping = new RollingTripping(60_000, 2, 0.5);
    const cb = new CircuitBreaker({ cooldownMs: 1000, isolateByModel: true, tripping });
    const forget = vi.spyOn(tripping, 'forget');

    cb.recordFailure('gpt');
    cb.recordFailure('gpt');
    expect(cb.getState('gpt')).toBe('open');

    cb.close('gpt');
    expect(forget).toHaveBeenCalledWith('gpt');

    cb.recordFailure('gpt');
    expect(cb.getState('gpt')).toBe('closed');

    cb.recordFailure('gpt');
    expect(cb.getState('gpt')).toBe('open');
  });

  it('minCalls gates tripping even at 100% failure ratio within the window', () => {
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 10, failureRatio: 0.5 },
    });

    for (let i = 0; i < 9; i++) cb.recordFailure();
    expect(cb.getState()).toBe('closed');

    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('a hand written plain object satisfying TrippingPolicy (not the shorthand, not a built in) is honored', () => {
    let failures = 0;
    let resetCalls = 0;
    const custom: TrippingPolicy = {
      onSuccess: () => {
        failures = 0;
      },
      onFailure: () => ++failures >= 3,
      reset: () => {
        resetCalls += 1;
        failures = 0;
      },
    };

    const cb = new CircuitBreaker({ cooldownMs: 1000, tripping: custom });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    cb.close();
    expect(resetCalls).toBe(1);
  });

  it('reports a true consecutive-failure count via onStateChange even under rolling tripping', () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 2, failureRatio: 0.5 },
      onStateChange,
    });

    cb.recordFailure();
    cb.recordFailure();

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 2, undefined, undefined);
  });

  it('isolateByModel gives each model its own independent RollingTripping state', () => {
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      isolateByModel: true,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 2, failureRatio: 0.5 },
    });

    cb.recordFailure('model-a');
    cb.recordFailure('model-a');
    expect(cb.getState('model-a')).toBe('open');
    expect(cb.getState('model-b')).toBe('closed');
  });

  it('a bare custom TrippingPolicy that tracks state per key gets real per-model isolation automatically, no factory needed', () => {
    const failuresByKey = new Map<string, number>();
    const keyed: TrippingPolicy = {
      onSuccess: (key) => {
        failuresByKey.set(key, 0);
      },
      onFailure: (key) => {
        const next = (failuresByKey.get(key) ?? 0) + 1;
        failuresByKey.set(key, next);
        return next >= 3;
      },
      reset: (key) => {
        failuresByKey.set(key, 0);
      },
    };

    const cb = new CircuitBreaker({ cooldownMs: 1000, isolateByModel: true, tripping: keyed });

    cb.recordFailure('model-a');
    cb.recordFailure('model-a');
    cb.recordFailure('model-b');
    // model-a has failed twice, model-b once: neither has reached 3 yet.
    expect(cb.getState('model-a')).toBe('closed');
    expect(cb.getState('model-b')).toBe('closed');

    cb.recordFailure('model-a');
    expect(cb.getState('model-a')).toBe('open');
    expect(cb.getState('model-b')).toBe('closed');
  });

  it("a bare custom TrippingPolicy that ignores its key stays shared across models, by the policy's own choice", () => {
    let failures = 0;
    const unkeyed: TrippingPolicy = {
      onSuccess: () => {
        failures = 0;
      },
      onFailure: () => ++failures >= 3,
      reset: () => {
        failures = 0;
      },
    };

    const cb = new CircuitBreaker({ cooldownMs: 1000, isolateByModel: true, tripping: unkeyed });

    cb.recordFailure('model-a');
    cb.recordFailure('model-a');
    cb.recordFailure('model-b');
    // The unkeyed policy's single counter is now at 3, regardless of which model contributed.
    expect(cb.getState('model-b')).toBe('open');
    // model-a itself only ever failed twice, but shares the same policy's counter.
    expect(cb.getState('model-a')).toBe('closed');
  });

  it('isolateByModel off collapses tripping to one shared key, even when calls pass different `model` values', () => {
    const seenKeys: string[] = [];
    const recording: TrippingPolicy = {
      onSuccess: () => {},
      onFailure: (key) => {
        seenKeys.push(key);
        return seenKeys.length >= 3;
      },
      reset: () => {},
    };

    // isolateByModel defaults to false.
    const cb = new CircuitBreaker({ cooldownMs: 1000, tripping: recording });

    cb.recordFailure('model-a');
    cb.recordFailure('model-b');
    cb.recordFailure('model-c');

    // Every call collapsed to the same key, despite three different `model` values.
    expect(new Set(seenKeys).size).toBe(1);
    expect(cb.getState()).toBe('open');
  });
});

describe('RollingTripping (unit)', () => {
  it('throws for an invalid minCalls', () => {
    expect(() => new RollingTripping(60_000, -1, 0.5)).toThrow(RangeError);
    expect(() => new RollingTripping(60_000, 1.5, 0.5)).toThrow(RangeError);
  });

  it('throws for an invalid failureRatio', () => {
    expect(() => new RollingTripping(60_000, 4, -0.1)).toThrow(RangeError);
    expect(() => new RollingTripping(60_000, 4, 1.1)).toThrow(RangeError);
    expect(() => new RollingTripping(60_000, 4, NaN)).toThrow(RangeError);
  });

  it('accepts the boundary values 0 and 1 for failureRatio, and 0 for minCalls', () => {
    expect(() => new RollingTripping(60_000, 0, 0)).not.toThrow();
    expect(() => new RollingTripping(60_000, 0, 1)).not.toThrow();
  });

  it('trips once minCalls and failureRatio are both satisfied within the window', () => {
    const tripping = new RollingTripping(60_000, 4, 0.5);

    expect(tripping.onFailure('k')).toBe(false); // 1/1
    tripping.onSuccess('k'); // 1/2
    expect(tripping.onFailure('k')).toBe(false); // 2/3, below minCalls
    expect(tripping.onFailure('k')).toBe(true); // 3/4, minCalls met, ratio 0.75
  });

  it('reset clears accumulated state for that key only', () => {
    const tripping = new RollingTripping(60_000, 3, 0.5);
    tripping.onFailure('k'); // 1/1
    tripping.onFailure('k'); // 2/2, one more would meet minCalls and trip

    tripping.reset('k');

    // Without the reset, this next failure would be the 3rd and would
    // trip (count 3 >= minCalls, ratio 1 >= 0.5). After reset it's back
    // to a fresh window, so it doesn't.
    expect(tripping.onFailure('k')).toBe(false);
  });

  it('tracks separate keys independently within the same instance', () => {
    const tripping = new RollingTripping(60_000, 2, 0.5);

    tripping.onFailure('model-a');
    tripping.onFailure('model-a');
    expect(tripping.onFailure('model-b')).toBe(false); // model-b's own count is 1, below minCalls
  });
});

describe('CircuitBreaker, rolling recovery (unit)', () => {
  it('clears pre-open failures when a half-open trial closes the circuit', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 4, failureRatio: 0.5 },
    });

    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(1001);
    cb.assertClosed();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');

    // One new failure must not reopen off the old window.
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
  });
});
