import { describe, expect, it, vi } from 'vitest';

import { unrefTimer, type TimerHandle } from '../../../src/internal/timers.utils.js';

describe('unrefTimer', () => {
  it('calls unref when the timer has one', () => {
    const unref = vi.fn();
    unrefTimer({ unref } as unknown as TimerHandle);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('does nothing when the environment gives a timer without unref, like a browser number', () => {
    expect(() => unrefTimer(1 as unknown as TimerHandle)).not.toThrow();
    expect(() => unrefTimer({} as TimerHandle)).not.toThrow();
  });
});
