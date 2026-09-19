import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPoller } from '../../../src/internal/poller.utils.js';

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on every interval once started', () => {
    const tick = vi.fn();
    createPoller(100, tick, () => false).start();

    vi.advanceTimersByTime(350);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('starts only one interval however many times start is called', () => {
    const tick = vi.fn();
    const poller = createPoller(100, tick, () => false);
    poller.start();
    poller.start();

    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('never starts when the interval is 0 or less', () => {
    const tick = vi.fn();
    createPoller(0, tick, () => false).start();
    createPoller(-5, tick, () => false).start();

    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('never starts once disposed', () => {
    const tick = vi.fn();
    createPoller(100, tick, () => true).start();

    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('stops ticking after stop, and can be started again', () => {
    const tick = vi.fn();
    const poller = createPoller(100, tick, () => false);
    poller.start();
    vi.advanceTimersByTime(100);
    poller.stop();

    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(1);

    poller.start();
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('treats stop as a no-op when never started', () => {
    expect(() => createPoller(100, vi.fn(), () => false).stop()).not.toThrow();
  });
});
