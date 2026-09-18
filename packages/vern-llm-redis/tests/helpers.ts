import { Redis } from 'ioredis';
import { createClient, type RedisClientType } from 'redis';
import { vi } from 'vitest';

import type { RedisClient, RedisSubscriber } from '../src/types.js';
import type { LLMClient } from 'vern-llm';

/** A RedisClient stand-in whose eval/get/set/del/scan are individually stubbable per test, no real Redis involved. scan defaults to an empty result (no keys, cursor '0'), so redisCircuitBreaker's startup snapshot is a no-op unless a test explicitly configures otherwise, and never touches eval's own mock queue. */
export function fakeRedisClient(): RedisClient & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn<RedisClient['get']>(),
    set: vi.fn<RedisClient['set']>(),
    del: vi.fn<RedisClient['del']>(),
    eval: vi.fn<RedisClient['eval']>(),
    scan: vi.fn(async () => ['0', []] as [string, string[]]),
  };
}

/** A RedisSubscriber stand-in that lets a test fire a message directly, without a real pub/sub connection. */
export function fakeSubscriber(): RedisSubscriber & {
  subscribe: ReturnType<typeof vi.fn>;
  emit: (channel: string, message: string) => void;
} {
  const listeners: Array<(channel: string, message: string) => void> = [];

  return {
    subscribe: vi.fn(async () => undefined),
    on(event, listener) {
      if (event === 'message') listeners.push(listener);
      return this;
    },
    emit(channel, message) {
      for (const listener of listeners) listener(channel, message);
    },
  };
}

/** A fresh ioredis connection to the local Redis instance the integration suite runs against. */
export function connect(): Redis {
  return new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });
}

/**
 * A fresh, already-connected node-redis (the "redis" package) connection
 * to the same local Redis instance, for integration tests that exercise
 * fromNodeRedis/fromNodeRedisSubscriber specifically.
 */
export async function connectNodeRedis(): Promise<RedisClientType> {
  const client = createClient({ socket: { host: '127.0.0.1', port: 6379 } });
  await client.connect();
  return client as RedisClientType;
}

/**
 * Polls condition until it returns true, or throws once timeoutMs
 * elapses. For asserting an async background operation has landed (a
 * circuit breaker's fire-and-forget Redis confirmation, e.g.), this is
 * more robust than a single fixed sleep followed by one assertion
 * attempt: a fixed sleep flakes whenever that one round trip happens to
 * take longer than the wait chosen, which real network variance
 * eventually produces no matter how generous the fixed wait is.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 2000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

/** A unique key prefix per test, so parallel tests never collide over the same Redis keys. */
export function uniquePrefix(base: string): string {
  return `${base}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/**
 * Longest a call meant to be "near instant" (not made to wait for
 * rate-limit capacity) is allowed to take, in ms. Deliberately generous:
 * a real network round trip is never exactly instant, and the two
 * client libraries this suite exercises differ in overhead (node-redis's
 * RESP3 handshake costs more per command than ioredis over the same
 * connection), so a tight literal like 50ms doesn't really assert "this
 * call wasn't delayed for capacity", it asserts "raw network latency
 * stayed under an arbitrary and occasionally too-tight number", exactly
 * the kind of assertion that flakes under real CI load or a slower
 * client. This only needs to stay well below the seconds-scale waits a
 * genuine rate-limit block produces elsewhere in these same tests, not
 * act as a tight bound on raw network latency.
 *
 * Where there's a second duration to compare against instead (a genuine
 * wait vs a near-instant one), prefer a relative assertion over this
 * absolute one, e.g. `expect(blocked.waitedMs).toBeGreaterThan(unblocked.waitedMs)`,
 * matching how vern-llm's own integration tests assert timing.
 */
export const NEAR_INSTANT_MS = 500;

/** Asserts ms is small enough to mean "this call was not made to wait for capacity", not a tight bound on raw network latency. */
export function expectNearInstant(ms: number): void {
  if (ms >= NEAR_INSTANT_MS) {
    throw new Error(
      `Expected a near-instant call (< ${NEAR_INSTANT_MS}ms), took ${ms}ms. ` +
        'If this fails consistently, it is a real regression. If only occasionally, ' +
        'NEAR_INSTANT_MS may need to grow further for this environment.',
    );
  }
}

/**
 * A minimal stand-in for vern-llm's own (private, test-only)
 * createMockClient, rebuilt here since it isn't part of vern-llm's
 * public exports. Matches the same LLMClient shape: a scripted queue of
 * responses or errors, one consumed per call, the last entry repeating
 * once the queue runs out.
 */
export function createMockClient(script: Array<{ content: string } | Error>): {
  client: LLMClient;
  create: ReturnType<typeof vi.fn>;
} {
  let i = 0;

  const create = vi.fn(async () => {
    const entry = script[Math.min(i, script.length - 1)];
    i += 1;

    if (!entry) throw new Error('createMockClient: script is empty');
    if (entry instanceof Error) throw entry;

    return { choices: [{ message: { content: entry.content } }] };
  });

  const client: LLMClient = { chat: { completions: { create } } };
  return { client, create };
}
