import { describe, expect } from 'vitest';

import { fromIoredisSubscriber } from '../../../src/clients/ioredis.js';
import { it } from '../../fixtures.js';
import { expectNearInstant, uniquePrefix, waitUntil } from '../../helpers.js';

import type { Redis } from 'ioredis';

describe.concurrent('redisRateLimit, real Redis, single process', () => {
  it('allows calls up to the requests-per-minute ceiling, then makes a further call wait', async ({
    makeLimiter,
  }) => {
    const limiter = makeLimiter({
      requestsPerMinute: 2,
      keyPrefix: uniquePrefix('rl'),
    });

    const first = await limiter.acquire(1);
    const second = await limiter.acquire(1);
    expect(first.waitedMs).toBeGreaterThanOrEqual(0);
    expect(second.waitedMs).toBeGreaterThanOrEqual(0);

    const controller = new AbortController();
    let settled = false;
    const thirdPromise = limiter
      .acquire(1, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    // Still blocked well past when an available-capacity call would
    // have resolved, proving the ceiling is actually being enforced.
    expect(settled).toBe(false);

    controller.abort();
    await thirdPromise;
  });

  it('enforces max concurrency, blocking until a release frees a slot', async ({ makeLimiter }) => {
    const limiter = makeLimiter({
      maxConcurrent: 1,
      pollIntervalMs: 50,
      keyPrefix: uniquePrefix('rl'),
    });

    const { release } = await limiter.acquire(1);

    let secondResolved = false;
    const secondPromise = limiter.acquire(1).then((result) => {
      secondResolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondResolved).toBe(false);

    release();
    const second = await secondPromise;
    expect(second.reason).toBe('concurrency');
  });

  it('tokens/min blocks a call whose estimate exceeds remaining budget, then admits it once it refills', async ({
    makeLimiter,
  }) => {
    const limiter = makeLimiter({
      tokensPerMinute: 6000, // 100/sec, drained fully below so the deficit refills in ~500ms
      keyPrefix: uniquePrefix('rl'),
    });

    await limiter.acquire(6000); // takes the entire bucket in one call
    const second = await limiter.acquire(50);

    expect(second.waitedMs).toBeGreaterThan(0);
    expect(second.reason).toBe('tpm');
  });

  it('release reconciles the tokens bucket, letting a later call in sooner than the full estimate would allow', async ({
    makeLimiter,
  }) => {
    const limiter = makeLimiter({
      tokensPerMinute: 120,
      keyPrefix: uniquePrefix('rl'),
    });

    const first = await limiter.acquire(100);
    first.release(10); // actually used far less than estimated, gives 90 back

    const second = await limiter.acquire(50);
    // With the reconciled give-back, this should not have to wait long.
    expectNearInstant(second.waitedMs);
  });

  it('throws once maxQueueMs is exceeded while genuinely out of capacity', async ({
    makeLimiter,
  }) => {
    const limiter = makeLimiter({
      requestsPerMinute: 1, // one per minute: the second call has nowhere near enough time
      maxQueueMs: 300,
      keyPrefix: uniquePrefix('rl'),
    });

    await limiter.acquire(1);
    await expect(limiter.acquire(1)).rejects.toMatchObject({ type: 'rate_limited' });
  });
});

describe.concurrent('redisRateLimit, real Redis, AIMD shared across two processes', () => {
  it('a shrink signaled by one process lowers the ceiling every process reads', async ({
    newConnection,
    makeLimiter,
  }) => {
    const redisB = newConnection();
    const keyPrefix = uniquePrefix('rl');
    const aimd = { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 };

    const limiterA = makeLimiter({
      requestsPerMinute: 10,
      aimd,
      keyPrefix,
    });
    // Constructed to prove the key isn't scoped to one adapter instance;
    // its own reads go through the same Redis key regardless.
    makeLimiter({ requestsPerMinute: 10, aimd, keyPrefix }, redisB);

    limiterA.signalRateLimit(); // 10 -> 5

    // Read the shared ceiling directly from process B's own connection,
    // proving the write landed in the one key both processes read,
    // rather than relying on real-time refill to observe the effect.
    await waitUntil(async () => {
      const cap = await redisB.hget(`${keyPrefix}:rpm`, 'cap');
      return Number(cap) === 5;
    });
  });

  it('a successful release grows the ceiling for every process', async ({
    newConnection,
    makeLimiter,
  }) => {
    const redisB = newConnection();
    const keyPrefix = uniquePrefix('rl');
    const aimd = { increaseBy: 5, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 100 };

    const limiterA = makeLimiter({ requestsPerMinute: 1, aimd, keyPrefix });

    const first = await limiterA.acquire(1);
    first.release(undefined, true); // grows 1 -> 6

    await waitUntil(async () => {
      const cap = await redisB.hget(`${keyPrefix}:rpm`, 'cap');
      return Number(cap) === 6;
    });
  });
});

describe.concurrent('redisRateLimit, real Redis, concurrency wake via subscriber', () => {
  it('a release from one process wakes a waiter blocked on another process, faster than the fallback poll interval', async ({
    redis,
    newConnection,
    makeLimiter,
  }) => {
    const redisB = newConnection();
    const keyPrefix = uniquePrefix('rl');

    const subA = newConnection();
    const subB = newConnection();

    // Real signals instead of a guessed delay. ioredis doesn't emit a
    // 'subscribe' event on the client in this setup, but subscribe()'s
    // own promise resolves reliably once the channel is confirmed live,
    // so wrap it to expose that as a readiness signal from outside —
    // redisRateLimit still drives the real subscribe() call underneath.
    function trackSubscribe(client: Redis): Promise<void> {
      return new Promise((resolve) => {
        const original = client.subscribe.bind(client);
        client.subscribe = ((...args: Parameters<typeof original>) => {
          const result = original(...args);
          void result.then(() => resolve());
          return result;
        }) as typeof client.subscribe;
      });
    }
    const subscriberAReady = trackSubscribe(subA);
    const subscriberBReady = trackSubscribe(subB);

    const limiterA = makeLimiter(
      {
        maxConcurrent: 1,
        keyPrefix,
        subscriber: fromIoredisSubscriber(subA),
      },
      redis,
    );
    const limiterB = makeLimiter(
      {
        maxConcurrent: 1,
        pollIntervalMs: 5000, // deliberately slow fallback, to prove the wake beat it
        keyPrefix,
        subscriber: fromIoredisSubscriber(subB),
      },
      redisB,
    );

    const { release } = await limiterA.acquire(1);

    const startedAt = Date.now();
    const waiter = limiterB.acquire(1);

    // limiterB.acquire's failed take attempt is the first command it sends
    // on redisB; waiter registration is synchronous local state set right
    // in that attempt's continuation, so a follow-up command on that same
    // connection only resolves once that continuation has already run,
    // since ioredis delivers responses on one connection strictly in order.
    await redisB.ping();
    await Promise.all([subscriberAReady, subscriberBReady]);

    release();

    await waiter;
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
