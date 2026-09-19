import { Cluster } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redisCache } from '../../src/cache.js';
import { redisCircuitBreaker } from '../../src/circuitBreaker.js';
import { fromIoredis, fromIoredisSubscriber } from '../../src/clients/ioredis.js';
import { redisRateLimit } from '../../src/rateLimit.js';
import { claimTrial, sleep } from '../breakerHelpers.js';
import { uniquePrefix, waitUntil } from '../helpers.js';

/**
 * Runs only against a real Redis Cluster, set `REDIS_CLUSTER_NODES` to a
 * comma separated `host:port` list (e.g. `127.0.0.1:7001,127.0.0.1:7002`).
 * Every script must touch only the one key it is given, or the cluster
 * rejects it with CROSSSLOT, and scripts, pub/sub and time all have to
 * behave the same as on a single node.
 */
const nodes = (process.env.REDIS_CLUSTER_NODES ?? '')
  .split(',')
  .filter(Boolean)
  .map((entry) => {
    const [host, port] = entry.split(':');
    return { host: host!, port: Number(port) };
  });

describe.skipIf(nodes.length === 0)('against a real Redis Cluster', () => {
  const clusters: Cluster[] = [];
  const disposables: Array<{ dispose(): void }> = [];

  /** Registers an adapter so it is disposed before its connections are closed. */
  function track<T extends { dispose(): void }>(adapter: T): T {
    disposables.push(adapter);
    return adapter;
  }

  function connect(): Cluster {
    const cluster = new Cluster(nodes, { lazyConnect: false });
    clusters.push(cluster);
    return cluster;
  }

  const mkBreaker = (
    client: ReturnType<typeof fromIoredis>,
    options: Parameters<typeof redisCircuitBreaker>[1],
  ) => track(redisCircuitBreaker(client, options));
  const mkLimiter = (
    client: ReturnType<typeof fromIoredis>,
    options: Parameters<typeof redisRateLimit>[1],
  ) => track(redisRateLimit(client, options));

  beforeEach(() => {
    clusters.length = 0;
  });

  afterEach(async () => {
    for (const adapter of disposables.splice(0)) adapter.dispose();
    await sleep(50);
    await Promise.all(clusters.splice(0).map((c) => c.quit().catch(() => {})));
  });

  it('the cache round trips across slots', async () => {
    const cache = redisCache<{ n: number }>(fromIoredis(connect()), {
      keyPrefix: uniquePrefix('c'),
    });

    for (let i = 0; i < 20; i++) await cache.set(`k${i}`, { n: i }, 30);
    for (let i = 0; i < 20; i++)
      expect(await cache.get(`k${i}`)).toEqual({ hit: true, value: { n: i } });
  });

  it('the circuit breaker trips, half opens, and closes, shared by two processes', async () => {
    const prefix = uniquePrefix('cb');
    const a = mkBreaker(fromIoredis(connect()), {
      keyPrefix: prefix,
      threshold: 2,
      cooldownMs: 200,
      pollIntervalMs: 0,
      logger: 'silent',
    });
    const b = mkBreaker(fromIoredis(connect()), {
      keyPrefix: prefix,
      threshold: 2,
      cooldownMs: 200,
      pollIntervalMs: 0,
      logger: 'silent',
    });

    a.recordFailure('m');
    a.recordFailure('m');
    await waitUntil(() => a.getState?.('m') === 'open');

    // b learns through a call of its own, then both wait out the cooldown.
    await waitUntil(() => {
      try {
        b.assertClosed('m');
        return false;
      } catch {
        return b.getState?.('m') === 'open';
      }
    });
    await sleep(300);

    const trial = await claimTrial(a);
    a.recordSuccess('m', trial);
    await waitUntil(() => a.getState?.('m') === 'closed');

    a.dispose();
    b.dispose();
  });

  it('prepare and readState work across nodes: a fresh process learns an open circuit on its first call', async () => {
    const prefix = uniquePrefix('cb');
    const options = {
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 30_000,
      pollIntervalMs: 0,
      logger: 'silent' as const,
    };
    const a = mkBreaker(fromIoredis(connect()), options);
    const b = mkBreaker(fromIoredis(connect()), options);

    a.recordFailure('m');
    await waitUntil(() => a.getState?.('m') === 'open');

    expect(await b.readState?.('m')).toBe('open');

    const fresh = mkBreaker(fromIoredis(connect()), options);
    await fresh.prepare?.('m');
    expect(() => fresh.assertClosed('m')).toThrowError(/open/);
  });

  it('half open lease reclaim works across nodes', async () => {
    const prefix = uniquePrefix('cb');
    const cluster = connect();
    const holder = mkBreaker(fromIoredis(cluster), {
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      probeLeaseMs: 300,
      pollIntervalMs: 0,
      logger: 'silent',
    });
    holder.recordFailure('m');
    await waitUntil(() => holder.getState?.('m') === 'open');
    await sleep(200);

    await claimTrial(holder);
    // The holder now goes silent. A fresh process takes over after the lease.
    const other = mkBreaker(fromIoredis(connect()), {
      keyPrefix: prefix,
      threshold: 1,
      cooldownMs: 150,
      probeLeaseMs: 300,
      pollIntervalMs: 0,
      logger: 'silent',
    });
    const trial = await claimTrial(other, { timeoutMs: 4000 });
    other.recordSuccess('m', trial);
    await waitUntil(() => other.getState?.('m') === 'closed');

    holder.dispose();
    other.dispose();
  });

  it('rate limit: leases, fair queue and readState work with keys on different slots', async () => {
    const prefix = uniquePrefix('rl');
    const options = {
      keyPrefix: prefix,
      requestsPerMinute: 60,
      tokensPerMinute: 60_000,
      maxConcurrent: 1,
      pollIntervalMs: 40,
      maxQueueMs: 8000,
      logger: 'silent' as const,
    };
    const limiters = [0, 1, 2, 3].map(() => mkLimiter(fromIoredis(connect()), options));

    const held = await limiters[0]!.acquire(10);

    const order: string[] = [];
    const releases: Array<() => void> = [];
    const waiters = ['B', 'C', 'D'].map(async (name, i) => {
      await sleep(i * 70);
      const got = await limiters[i + 1]!.acquire(10);
      order.push(name);
      releases.push(() => got.release());
    });
    await sleep(400);

    const state = await limiters[0]!.readState();
    expect(state.concurrentInFlight).toBe(1);
    expect(state.requestsRemaining).toBeLessThan(60);

    held.release();
    for (let i = 0; i < 3; i++) {
      await waitUntil(() => releases.length > i, { timeoutMs: 5000 });
      releases[i]!();
    }
    await Promise.all(waiters);

    expect(order).toEqual(['B', 'C', 'D']);
    limiters.forEach((l) => l.dispose());
  });

  it('a crashed holder frees its concurrency slot after the lease', async () => {
    const prefix = uniquePrefix('rl');
    const options = {
      keyPrefix: prefix,
      maxConcurrent: 1,
      concurrencyLeaseMs: 300,
      pollIntervalMs: 50,
      maxQueueMs: 4000,
      logger: 'silent' as const,
    };
    const crashed = mkLimiter(fromIoredis(connect()), options);
    const survivor = mkLimiter(fromIoredis(connect()), options);

    await crashed.acquire(1);
    crashed.dispose(); // renewals stop, release never runs

    const got = await survivor.acquire(1);
    expect(got.waitedMs).toBeGreaterThan(100);
    survivor.dispose();
  });

  it('pub/sub wakes a waiter on another connection promptly', async () => {
    const prefix = uniquePrefix('rl');
    const publisher = connect();
    const waiterSub = connect();
    const base = {
      keyPrefix: prefix,
      maxConcurrent: 1,
      maxQueueMs: 8000,
      logger: 'silent' as const,
    };

    const holder = mkLimiter(fromIoredis(publisher), base);
    const waiter = mkLimiter(fromIoredis(connect()), {
      ...base,
      pollIntervalMs: 5000,
      subscriber: fromIoredisSubscriber(waiterSub.duplicate()),
    });

    const held = await holder.acquire(1);
    await sleep(400); // the subscription is live
    let acquiredAt = 0;
    const waiting = waiter.acquire(1).then(() => (acquiredAt = Date.now()));
    await sleep(300);

    const releasedAt = Date.now();
    held.release();
    await waiting;

    expect(acquiredAt - releasedAt).toBeLessThan(1500);
    holder.dispose();
    waiter.dispose();
  });
});
