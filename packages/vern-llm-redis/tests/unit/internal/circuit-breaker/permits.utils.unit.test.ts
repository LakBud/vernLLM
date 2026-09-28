import { describe, expect, it, vi } from 'vitest';

import { createPermits } from '../../../../src/internal/circuit-breaker/calls/permits.utils.js';
import { callContext } from '../../../breakerHelpers.js';

function setup() {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const heartbeats = {
    start: vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    }),
    stopAll: vi.fn(),
  };
  const permits = createPermits({ heartbeats, probeLeaseMs: 3000, renew: vi.fn() });
  return { permits, stops, heartbeats };
}

describe('createPermits', () => {
  it('a repeat grant for the same call stops the renewal it replaces', () => {
    const { permits, stops } = setup();
    const context = callContext();

    permits.grant(context, 'cb:m', 'm', 'a');
    permits.grant(context, 'cb:m', 'm', 'b');

    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
    expect(permits.takeToken('cb:m', context)).toBe('b');
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });
});
