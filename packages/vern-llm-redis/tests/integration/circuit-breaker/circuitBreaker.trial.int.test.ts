import { describe, expect, vi } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { fromIoredis } from '../../../src/clients/ioredis.js';
import {
  callContext,
  claimTrial,
  claimTrials,
  isOpen,
  learn,
  sleep,
  trip,
} from '../../breakerHelpers.js';
import { it } from '../../fixtures.js';
import { connect, uniquePrefix, waitUntil } from '../../helpers.js';

describe.concurrent('redisCircuitBreaker half-open trials, real Redis', () => {
  it('a trial lease held by a process that never reports back is reclaimed, not held forever', async ({
    redis,
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const holder = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      probeLeaseMs: 400,
    });
    const other = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      probeLeaseMs: 400,
    });

    await trip(holder);
    await learn(other);
    await sleep(200);

    // `holder` wins the single trial slot and then goes silent (a crashed
    // or idle process): it never spends it and never reports an outcome.
    await waitUntil(() => {
      isOpen(holder);
      return redis.hget(`${prefix}`, 'slots').then((v) => v === '0');
    });

    // While the lease is fresh, `other` is refused.
    await waitUntil(() => isOpen(other) && other.getState?.('m') === 'half-open');
    expect(isOpen(other)).toBe(true);

    // Once the lease lapses, `other`'s own next call wins it.
    const c = await claimTrial(other, { timeoutMs: 3000 });
    other.recordSuccess('m', c);
    await waitUntil(() => other.getState?.('m') === 'closed');
  });

  it('releaseTrial hands the slot back so the same process can retry immediately', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 150 });

    await trip(breaker);
    await sleep(200);

    const first = await claimTrial(breaker);
    expect(isOpen(breaker)).toBe(true); // only slot is in flight

    // The call ended in an error the breaker doesn't count.
    breaker.releaseTrial?.('m', first);

    const second = await claimTrial(breaker);
    breaker.recordSuccess('m', second);
    await waitUntil(() => breaker.getState?.('m') === 'closed');
  });

  it('releaseTrial is a no-op for a call that never held a slot', async ({
    redis,
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 150 });

    await trip(breaker);
    await sleep(200);
    await claimTrial(breaker);

    breaker.releaseTrial?.('m', callContext());
    await sleep(100);

    expect(await redis.hget(prefix, 'slots')).toBe('0');
  });

  it('a late outcome from a holder whose lease was reclaimed cannot settle the new trial', async ({
    redis,
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const slow = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      probeLeaseMs: 300,
    });
    const fast = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      probeLeaseMs: 300,
    });

    await trip(slow);
    await learn(fast);
    await sleep(200);
    const slowCtx = await claimTrial(slow);
    await waitUntil(() => isOpen(fast) && fast.getState?.('m') === 'half-open');

    // `slow`'s call outlives its 300ms lease; `fast` takes the slot over.
    const fastCtx = await claimTrial(fast);

    // slow's stale success must not close the circuit.
    slow.recordSuccess('m', slowCtx);
    await sleep(150);
    expect(await redis.hget(prefix, 'state')).toBe('half-open');

    // fast's own success is the one that counts.
    fast.recordSuccess('m', fastCtx);
    await waitUntil(async () => (await redis.hget(prefix, 'state')) === 'closed');
  });

  it('a late success from a call that started before the trip does not close an open circuit', async ({
    redis,
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 5000 });

    await trip(breaker);

    // A call admitted while closed finishes after the trip.
    breaker.recordSuccess('m', callContext());
    await sleep(150);

    expect(await redis.hget(prefix, 'state')).toBe('open');
    expect(isOpen(breaker)).toBe(true);
  });

  it('an idle poll never wins a trial slot for a process with no recent calls', async ({
    redis,
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const idle = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 100,
      pollIntervalMs: 60,
    });

    // One call, so the key is tracked by the poll, then nothing.
    idle.recordFailure('m');
    await waitUntil(() => idle.getState?.('m') === 'open');
    await sleep(600);

    // Cooldown is long over and the poll has run many times, yet no trial
    // ever began on this process's behalf: still open, epoch never bumped.
    expect(await redis.hget(prefix, 'state')).toBe('open');
    expect(await redis.hget(prefix, 'epoch')).toBe('0');
  });
});

describe.concurrent('redisCircuitBreaker parity with core options, real Redis', () => {
  it('halfOpenProbes admits that many trials, and halfOpenSuccessRatio decides the outcome', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      halfOpenProbes: 3,
      halfOpenSuccessRatio: 2 / 3,
    });

    await trip(breaker);
    await sleep(200);

    const granted = await claimTrials(breaker, 3);
    expect(isOpen(breaker)).toBe(true); // no fourth slot

    breaker.recordSuccess('m', granted[0]);
    breaker.recordFailure('m', granted[1]);
    breaker.recordSuccess('m', granted[2]);

    // 2 of 3 succeeded, meeting the ratio.
    await waitUntil(() => breaker.getState?.('m') === 'closed');
  });

  it('a trial short of halfOpenSuccessRatio reopens the circuit', async ({ makeBreaker }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      halfOpenProbes: 2,
    });

    await trip(breaker);
    await sleep(200);

    const a = await claimTrial(breaker);
    const b = await claimTrial(breaker);
    breaker.recordSuccess('m', a);
    breaker.recordFailure('m', b);

    await waitUntil(() => breaker.getState?.('m') === 'open');
  });

  it('rolling tripping opens on failure ratio, not consecutive failures', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({
      keyPrefix: prefix,
      cooldownMs: 5000,
      tripping: { kind: 'rolling', windowMs: 10_000, minCalls: 4, failureRatio: 0.5 },
    });

    // fail, ok, fail, ok: never two in a row, ratio 0.5 once minCalls reached.
    breaker.recordFailure('m');
    breaker.recordSuccess('m');
    breaker.recordFailure('m');
    await sleep(100);
    expect(breaker.getState?.('m')).toBe('closed'); // only 3 calls, under minCalls

    breaker.recordSuccess('m');
    // Sequential outcomes are independent round trips, wait for each to land.
    await waitUntil(() => breaker.getState?.('m') === 'closed');
    breaker.recordFailure('m');
    await waitUntil(() => breaker.getState?.('m') === 'open');
  });

  it('getFailureBreakdown reports failures by error code, and a close clears it', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({ keyPrefix: prefix, threshold: 10, cooldownMs: 5000 });

    breaker.recordFailure('m', undefined, 'request_timeout');
    breaker.recordFailure('m', undefined, 'request_timeout');
    breaker.recordFailure('m', undefined, undefined);
    await waitUntil(() => (breaker.getFailureBreakdown?.('m')?.unknown ?? 0) === 1);

    expect(breaker.getFailureBreakdown?.('m')).toEqual({ request_timeout: 2, unknown: 1 });

    breaker.close?.('m');
    await waitUntil(() => Object.keys(breaker.getFailureBreakdown?.('m') ?? {}).length === 0);
  });

  it('open() and close() force the transition from any process', async ({ redis, makeBreaker }) => {
    const prefix = uniquePrefix('cb');
    const a = makeBreaker({ keyPrefix: prefix, threshold: 10, cooldownMs: 5000 });
    const b = makeBreaker({ keyPrefix: prefix, threshold: 10, cooldownMs: 5000 });

    a.open?.('m');
    await waitUntil(() => a.getState?.('m') === 'open');

    // b only learns about it through a call of its own.
    await waitUntil(() => isOpen(b));
    expect(await redis.hget(prefix, 'state')).toBe('open');

    b.close?.('m');
    await waitUntil(async () => (await redis.hget(prefix, 'state')) === 'closed');
    await waitUntil(() => !isOpen(b));
  });
});

/**
 * These change something every test shares (the clock, randomness), so they
 * run on their own, after the concurrent blocks above have finished.
 */
describe('redisCircuitBreaker with a faked clock or randomness, real Redis', () => {
  it('cooldown is measured on the Redis clock, so a skewed client clock cannot pin a circuit open', async ({
    makeBreaker,
  }) => {
    const prefix = uniquePrefix('cb');
    const breaker = makeBreaker({ keyPrefix: prefix, threshold: 1, cooldownMs: 200 });

    // This process's clock is ten minutes ahead when it records the failure.
    const realNow = Date.now.bind(Date);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 60_000);
    breaker.recordFailure('m');
    await waitUntil(() => breaker.getState?.('m') === 'open');
    now.mockRestore();

    // Measured on Redis time, the cooldown ends ~200ms later. Measured on
    // the caller's clock it would have been ten minutes.
    const trial = await claimTrial(breaker, { timeoutMs: 2000 });
    breaker.recordSuccess('m', trial);
    await waitUntil(() => breaker.getState?.('m') === 'closed');
  });

  it('cooldownBackoff grows the cooldown on each repeat open', async ({ redis, makeBreaker }) => {
    const prefix = uniquePrefix('cb');
    // rand = 1, so jitter is a no-op and the growth is deterministic.
    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    const breaker = makeBreaker({
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 100,
      cooldownBackoff: { multiplier: 3, maxMs: 10_000 },
    });

    await trip(breaker);
    expect(await redis.hget(prefix, 'cooldown')).toBe('100');

    await sleep(150);
    const trial = await claimTrial(breaker);
    breaker.recordFailure('m', trial);

    await waitUntil(async () => (await redis.hget(prefix, 'state')) === 'open');
    expect(await redis.hget(prefix, 'cooldown')).toBe('300');
    random.mockRestore();
  });
});

describe('redisCircuitBreaker dispose, real Redis', () => {
  it('stops polling and stays quiet once the client is closed', async () => {
    const redis = connect();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const breaker = redisCircuitBreaker(fromIoredis(redis), {
      keyPrefix: uniquePrefix('cb'),
      pollIntervalMs: 30,
    });

    breaker.recordFailure('m');
    await waitUntil(async () => breaker.getState?.('m') !== undefined);
    breaker.dispose();
    await redis.quit();

    await sleep(200);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('is idempotent', () => {
    const redis = connect();
    const breaker = redisCircuitBreaker(fromIoredis(redis), { keyPrefix: uniquePrefix('cb') });

    expect(() => {
      breaker.dispose();
      breaker.dispose();
    }).not.toThrow();
    return redis.quit();
  });
});
