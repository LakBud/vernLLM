import { describe, expect, vi } from 'vitest';

import { callContext, claimTrials, isOpen, sleep, trip } from '../../breakerHelpers.js';
import { it } from '../../fixtures.js';
import { uniquePrefix, waitUntil } from '../../helpers.js';

import type { Redis } from 'ioredis';

/**
 * Background checks overlap when Redis answers slower than the caller
 * asks: a burst of calls, or a machine busy enough that round trips take
 * longer than a poll interval. Each check that wins a half-open slot owns
 * it, so every one of them has to stay usable.
 */
describe.concurrent('half-open trials when checks overlap, real Redis', () => {
  const options = {
    threshold: 1,
    cooldownMs: 150,
    halfOpenProbes: 3,
  };

  /**
   * Delays every Redis call this connection makes by `latencyMs`, standing in
   * for a slow or busy Redis. Returns a function that waits until no call is
   * still in flight, so the test never closes the connection under one.
   */
  function slowDown(redis: Redis, latencyMs: number) {
    const realEval = redis.eval.bind(redis) as (...args: unknown[]) => Promise<unknown>;
    let inFlight = 0;

    vi.spyOn(redis, 'eval').mockImplementation((async (...args: unknown[]) => {
      inFlight += 1;
      try {
        await sleep(latencyMs);
        return await realEval(...args);
      } finally {
        inFlight -= 1;
      }
    }) as never);

    return () => waitUntil(() => inFlight === 0);
  }

  it('a burst of simultaneous calls right after the cooldown still gets every slot', async ({
    makeBreaker,
  }) => {
    const breaker = makeBreaker({ ...options, keyPrefix: uniquePrefix('cb') });
    await trip(breaker);
    await sleep(250);

    for (let i = 0; i < 10; i++) {
      try {
        breaker.assertClosed('m', callContext());
      } catch {
        // rejected, but each one started a check
      }
    }
    await sleep(200);

    await expect(claimTrials(breaker, 3)).resolves.toHaveLength(3);
    expect(isOpen(breaker)).toBe(true); // there are only three
  });

  it.for([0, 30, 60, 120])(
    'gets all three slots when Redis takes %ims per call, longer than the poll interval',
    async (latencyMs, { redis, makeBreaker }) => {
      const drained = slowDown(redis, latencyMs);
      const breaker = makeBreaker({ ...options, keyPrefix: uniquePrefix('cb') });
      await trip(breaker);
      await sleep(200 + latencyMs);

      try {
        await expect(claimTrials(breaker, 3, { timeoutMs: 2500 })).resolves.toHaveLength(3);
      } finally {
        await drained();
      }
    },
  );
});
