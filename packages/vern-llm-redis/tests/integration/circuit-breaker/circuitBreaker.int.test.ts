import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { fromIoredis, fromIoredisSubscriber } from '../../../src/clients/ioredis.js';
import { connect, uniquePrefix, waitForSubscribers, waitUntil } from '../../helpers.js';

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

    // Cooldown has elapsed, but nothing has confirmed that with Redis
    // yet: assertClosed never optimistically guesses, so the next call
    // right after cooldown can still throw while it kicks off the async
    // confirmation in the background. Only once that confirmation lands
    // (this process wins the trial) does a call finally get through.
    await waitUntil(() => {
      try {
        breaker.assertClosed('m');
        return true;
      } catch {
        return false;
      }
    });
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

    // subscribe() isn't awaited by the adapter (fire-and-forget, as in
    // production), so wait for both SUBSCRIBEs to land before the transition
    // fires, or its message would be missed.
    await waitForSubscribers(redisA, `${keyPrefix}:events`, 2);

    breakerA.recordFailure('m');

    // breakerB never called recordFailure itself, pub/sub alone should
    // deliver the transition. Waiting on events rather than polling
    // assertClosed keeps its own checks out of the way, so this proves
    // the message path specifically.
    await waitUntil(() => events.length > 0);

    expect(() => breakerB.assertClosed('m')).toThrow();
    expect(events).toContainEqual({ from: 'closed', to: 'open' });
  });

  it('each process reports one change once, however many checks, replies and messages carry it', async () => {
    const keyPrefix = uniquePrefix('cb');
    const eventsA: string[] = [];
    const eventsB: string[] = [];
    const subscriberA = redisA.duplicate();
    const subscriberB = redisB.duplicate();
    const make = (redis: Redis, subscriber: Redis, events: string[]) =>
      redisCircuitBreaker(fromIoredis(redis), {
        threshold: 1,
        cooldownMs: 10_000,
        keyPrefix,
        pollIntervalMs: 0,
        logger: 'silent',
        subscriber: fromIoredisSubscriber(subscriber),
        onStateChange: (from, to) => events.push(`${from}->${to}`),
      });
    const breakerA = make(redisA, subscriberA, eventsA);
    const breakerB = make(redisB, subscriberB, eventsB);
    await waitForSubscribers(redisA, `${keyPrefix}:events`, 2);

    breakerA.recordFailure('m');
    breakerA.recordFailure('m');
    // Checks on both sides race the reply and the pub/sub message.
    for (let i = 0; i < 10; i++) {
      for (const breaker of [breakerA, breakerB]) {
        try {
          breaker.assertClosed('m');
        } catch {
          // Rejected once the trip is known, which is fine here.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitUntil(() => eventsA.length > 0 && eventsB.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(eventsA).toEqual(['closed->open']);
    expect(eventsB).toEqual(['closed->open']);

    breakerA.dispose();
    breakerB.dispose();
    await subscriberA.quit();
    await subscriberB.quit();
  });
});
