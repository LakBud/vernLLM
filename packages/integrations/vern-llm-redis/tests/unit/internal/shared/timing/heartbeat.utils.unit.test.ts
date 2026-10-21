import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHeartbeats,
  renewalInterval,
} from '../../../../../src/internal/shared/timing/heartbeat.utils.js';

describe('createHeartbeats', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats until stopped, one heartbeat at a time or all at once', () => {
    vi.useFakeTimers();
    const heartbeats = createHeartbeats();
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = heartbeats.start(first, 100);
    heartbeats.start(second, 100);
    vi.advanceTimersByTime(250);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 2]);

    stopFirst();
    vi.advanceTimersByTime(100);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 3]);

    heartbeats.stopAll();
    vi.advanceTimersByTime(1000);
    expect(second).toHaveBeenCalledTimes(3);
  });
});

describe('renewalInterval', () => {
  it.each([
    [3000, 1000],
    [10, 3],
    [2, 1],
    [0, 1],
  ])('renews a %s ms lease every %s ms', (leaseMs, expected) => {
    expect(renewalInterval(leaseMs)).toBe(expected);
  });
});
