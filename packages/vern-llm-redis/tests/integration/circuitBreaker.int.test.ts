import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redisCircuitBreaker } from '../../src/circuitBreaker.js';
import { fromIoredis, fromIoredisSubscriber } from '../../src/clients/ioredis.js';
import { connect, uniquePrefix, waitUntil } from '../helpers.js';

import type { Redis } from 'ioredis';

describe('redisCircuitBreaker, real Redis, single process', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = connect();
  });

  afterEach(async () => {
    await redis.quit();
  });

  it('opens after threshold consecutive failures and blocks further calls', async () => {
    const breaker = redisCircuitBreaker(fromIoredis(redis), {
      threshold: 2,
      cooldownMs: 500,
      keyPrefix: uniquePrefix('cb'),
    });

    expect(() => breaker.assertClosed('m')).not.toThrow();
    breaker.recordFailure('m');
    breaker.recordFailure('m');

    // Waits for recordFailure's own background confirmation against
    // Redis to land in the local cache, rather than a fixed sleep that
    // flakes whenever that one round trip happens to take longer.
    await waitUntil(() => {
      try {
        breaker.assertClosed('m');
        return false;
      } catch {
        return true;
      }
    });

    expect(() => breaker.assertClosed('m')).toThrow();
  });

  it('a success in between failures resets the consecutive failure count', async () => {
    const breaker = redisCircuitBreaker(fromIoredis(redis), {
      threshold: 2,
      cooldownMs: 500,
      keyPrefix: uniquePrefix('cb'),
    });

    breaker.recordFailure('m');
    breaker.recordSuccess('m');
    breaker.recordFailure('m');

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only one consecutive failure since the reset, still under threshold.
    expect(() => breaker.assertClosed('m')).not.toThrow();
  });

  it('transitions open to half-open once the cooldown elapses, allowing a trial call through', async () => {
    const breaker = redisCircuitBreaker(fromIoredis(redis), {
      threshold: 1,
      cooldownMs: 300,
      keyPrefix: uniquePrefix('cb'),
    });

    breaker.recordFailure('m');
    await waitUntil(() => {
      try {
        breaker.assertClosed('m');
        return false;
      } catch {
        return true;
      }
    });
    expect(() => breaker.assertClosed('m')).toThrow();

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Cooldown elapsed: the trial call is let through, not blocked.
    expect(() => breaker.assertClosed('m')).not.toThrow();
  });

  it('isolateByModel keeps a failing model from blocking a different, healthy model', async () => {
    const breaker = redisCircuitBreaker(fromIoredis(redis), {
      threshold: 1,
      cooldownMs: 10_000,
      isolateByModel: true,
      keyPrefix: uniquePrefix('cb'),
    });

    breaker.recordFailure('bad-model');
    await waitUntil(() => {
      try {
        breaker.assertClosed('bad-model');
        return false;
      } catch {
        return true;
      }
    });

    expect(() => breaker.assertClosed('bad-model')).toThrow();
    expect(() => breaker.assertClosed('good-model')).not.toThrow();
  });
});

describe('redisCircuitBreaker, real Redis, two processes sharing state', () => {
  let redisA: Redis;
  let redisB: Redis;

  beforeEach(() => {
    redisA = connect();
    redisB = connect();
  });

  afterEach(async () => {
    await redisA.quit();
    await redisB.quit();
  });

  it('a trip recorded by one adapter is enforced by a second adapter reading the same key', async () => {
    const keyPrefix = uniquePrefix('cb');
    const breakerA = redisCircuitBreaker(fromIoredis(redisA), {
      threshold: 1,
      cooldownMs: 10_000,
      keyPrefix,
    });
    const breakerB = redisCircuitBreaker(fromIoredis(redisB), {
      threshold: 1,
      cooldownMs: 10_000,
      keyPrefix,
    });

    breakerA.recordFailure('m');

    // breakerB's own local cache never saw the failure directly, only
    // its own background check against the shared Redis key confirms
    // it. The first assertClosed call kicks that check off but can't
    // throw yet, the local cache hasn't updated; poll until it has,
    // rather than a fixed sleep that flakes whenever that round trip
    // happens to take longer than the wait chosen.
    await waitUntil(() => {
      try {
        breakerB.assertClosed('m');
        return false;
      } catch {
        return true;
      }
    });

    expect(() => breakerB.assertClosed('m')).toThrow();
  });

  it('with a subscriber on each side, a transition propagates without either process needing its own recorded outcome first', async () => {
    const keyPrefix = uniquePrefix('cb');
    const events: Array<{ from: string; to: string }> = [];

    const breakerA = redisCircuitBreaker(fromIoredis(redisA), {
      threshold: 1,
      cooldownMs: 10_000,
      keyPrefix,
      subscriber: fromIoredisSubscriber(redisA.duplicate()),
    });
    const breakerB = redisCircuitBreaker(fromIoredis(redisB), {
      threshold: 1,
      cooldownMs: 10_000,
      keyPrefix,
      subscriber: fromIoredisSubscriber(redisB.duplicate()),
      onStateChange: (from, to) => events.push({ from, to }),
    });

    // Give both SUBSCRIBE commands time to actually reach Redis before
    // the transition fires; subscribe() isn't awaited by the adapter
    // itself (fire-and-forget, matching production usage), so a message
    // published before the subscription lands would otherwise be missed.
    await new Promise((resolve) => setTimeout(resolve, 200));

    breakerA.recordFailure('m');

    // breakerB never called recordFailure itself, pub/sub alone should
    // deliver the transition and make assertClosed throw. Poll on
    // events itself, not by repeatedly calling assertClosed: each such
    // call fires its own background 'check' against Redis (see
    // redisCircuitBreaker's own docs on the no-subscriber fallback
    // path), which can race ahead of the pub/sub message and observe
    // the state as already open directly, a no-op from breakerB's own
    // perspective that steals the transition observation away from
    // pub/sub before it ever arrives, exactly the failure this test
    // exists to catch. Waiting on events avoids introducing that
    // competing check in the first place.
    await waitUntil(() => events.length > 0);

    expect(() => breakerB.assertClosed('m')).toThrow();
    expect(events).toContainEqual({ from: 'closed', to: 'open' });
  });
});
