import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  TargetState,
} from '../../../src/internal/targetState.js';

describe('TargetState', () => {
  it('counts attempts in flight and forgets a target with nothing left', () => {
    const state = new TargetState(1000);
    state.attemptStarted('a');
    state.attemptStarted('a');
    expect(state.read('a', 0).inFlight).toBe(2);

    state.attemptEnded('a', 0);
    state.attemptEnded('a', 0);
    state.attemptEnded('a', 0);

    expect(state.read('a', 0).inFlight).toBe(0);
    expect(state.size).toBe(0);
  });

  it('cools down for Retry-After, 5 seconds without one, and at most 60', () => {
    const state = new TargetState(1000);
    state.rateLimited('a', 2_000, 0);
    state.rateLimited('b', undefined, 0);
    state.rateLimited('c', 10 * MAX_COOLDOWN_MS, 0);

    expect(state.read('a', 1_999).cooling).toBe(true);
    expect(state.read('a', 2_000).cooling).toBe(false);
    expect(state.read('b', DEFAULT_COOLDOWN_MS - 1).cooling).toBe(true);
    expect(state.read('b', DEFAULT_COOLDOWN_MS).cooling).toBe(false);
    expect(state.read('c', MAX_COOLDOWN_MS - 1).cooling).toBe(true);
    expect(state.read('c', MAX_COOLDOWN_MS).cooling).toBe(false);
  });

  it('never shortens a running cooldown', () => {
    const state = new TargetState(1000);
    state.rateLimited('a', 10_000, 0);
    state.rateLimited('a', 1_000, 0);
    expect(state.read('a', 5_000).cooling).toBe(true);
  });

  it('ramps the warming factor from 0.1 to 1 and then forgets it', () => {
    const state = new TargetState(1000);
    state.recovered('a', 0);

    expect(state.read('a', 0).warmingFactor).toBeCloseTo(0.1);
    expect(state.read('a', 500).warmingFactor).toBeCloseTo(0.55);
    expect(state.read('a', 1000).warmingFactor).toBe(1);
    expect(state.size).toBe(0);
  });

  it('ignores a clock that went backwards', () => {
    const state = new TargetState(1000);
    state.recovered('a', 5_000);
    expect(state.read('a', 4_000).warmingFactor).toBe(1);
  });

  it('does not warm when slowStartMs is 0', () => {
    const state = new TargetState(0);
    state.recovered('a', 0);
    expect(state.read('a', 0).warmingFactor).toBe(1);
    expect(state.size).toBe(0);
  });

  it('caps how many targets it tracks', () => {
    const state = new TargetState(1000);
    for (let i = 0; i < 1000; i++) state.attemptStarted(`t${i}`);
    expect(state.size).toBe(256);
    state.rateLimited('late', 1, 0);
    state.recovered('late', 0);
    expect(state.read('late', 0)).toEqual({ inFlight: 0, cooling: false, warmingFactor: 1 });
  });

  it('ignores an end for a target it never saw', () => {
    const state = new TargetState(1000);
    state.attemptEnded('ghost', 0);
    expect(state.size).toBe(0);
  });
});
