import { LLMError, VernLLM, type LLMClient } from 'vern-llm';
import { usageMiddleware, type UsageStore } from 'vern-llm-usage';
import { describe, expect } from 'vitest';

import { redisUsageStore, type UsageScope } from '../../../src/usageStore.js';
import { it } from '../../fixtures.js';
import { uniquePrefix, waitUntil } from '../../helpers.js';

import type { Redis } from 'ioredis';

const HOUR = 60 * 60 * 1000;

const scope = (key: string, overrides: Partial<UsageScope> = {}): UsageScope => ({
  key,
  label: `${key} per day`,
  unit: 'usd',
  limit: 1_000,
  mode: 'hard',
  resetsAtMs: Date.now() + HOUR,
  ...overrides,
});

const amount = (nanoUsd: number, tokens = 0) => ({ nanoUsd, tokens });

describe.concurrent('redisUsageStore, real Redis', () => {
  it('holds, settles and reads a scope', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const s = scope('a');

    const held = await store.reserve([s], amount(300, 30), 60_000);
    expect(held.ok).toBe(true);
    await expect(store.read(s)).resolves.toEqual({
      spent: amount(0),
      reserved: amount(300, 30),
    });

    if (held.ok) await store.commit(held.id, amount(120, 12));
    await expect(store.read(s)).resolves.toEqual({
      spent: amount(120, 12),
      reserved: amount(0),
    });
  });

  it('reports what each scope holds after the reservation, in its own unit', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const dollars = scope('d');
    const tokens = scope('t', { unit: 'tokens' });

    const first = await store.reserve([dollars, tokens], amount(300, 30), 60_000);
    expect(first).toMatchObject({ ok: true, used: [300, 30] });
    if (first.ok) await store.commit(first.id, amount(100, 10));

    // 100 spent, plus this hold of 50.
    await expect(store.reserve([dollars, tokens], amount(50, 5), 60_000)).resolves.toMatchObject({
      used: [150, 15],
    });
  });

  it('frees a hold on release without recording spend', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const s = scope('a');

    const held = await store.reserve([s], amount(300), 60_000);
    if (held.ok) await store.release(held.id);

    await expect(store.read(s)).resolves.toEqual({ spent: amount(0), reserved: amount(0) });
  });

  it('refuses a reservation that would go over, and says what is left', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const s = scope('a', { limit: 500 });

    await store.reserve([s], amount(400), 60_000);
    const refused = await store.reserve([s], amount(200), 60_000);

    expect(refused).toEqual({ ok: false, scope: s, remaining: 100 });
    // The refused call held nothing.
    await expect(store.read(s)).resolves.toMatchObject({ reserved: amount(400) });
  });

  it('never refuses a scope given the unreachable limit a soft budget uses, and keeps its spend', async ({
    redis,
  }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const soft = scope('soft', { limit: Number.MAX_SAFE_INTEGER, mode: 'soft' });

    for (let i = 0; i < 3; i++) {
      const held = await store.reserve([soft], amount(1_000_000_000_000), 60_000);
      expect(held.ok).toBe(true);
      if (held.ok) await store.commit(held.id, amount(1_000_000_000_000));
    }

    await expect(store.read(soft)).resolves.toEqual({
      spent: amount(3_000_000_000_000),
      reserved: amount(0),
    });
  });

  it('limits tokens and dollars independently', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const tokens = scope('t', { unit: 'tokens', limit: 50 });

    expect((await store.reserve([tokens], amount(999_999, 40), 60_000)).ok).toBe(true);
    expect(await store.reserve([tokens], amount(0, 20), 60_000)).toMatchObject({
      ok: false,
      remaining: 10,
    });
  });

  it('holds every scope or none', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const roomy = scope('roomy', { limit: 1_000 });
    const tight = scope('tight', { limit: 100 });

    const refused = await store.reserve([roomy, tight], amount(200), 60_000);

    expect(refused).toMatchObject({ ok: false, scope: tight, remaining: 100 });
    await expect(store.read(roomy)).resolves.toEqual({ spent: amount(0), reserved: amount(0) });
  });

  it('lets exactly as many parallel reservations through as fit', async ({
    redis,
    newConnection,
  }) => {
    const prefix = uniquePrefix('us');
    const stores = [redis, newConnection(), newConnection()].map((c) =>
      redisUsageStore(c, { keyPrefix: prefix }),
    );
    const s = scope('race', { limit: 100 });

    const outcomes = await Promise.all(
      Array.from({ length: 30 }, (_, i) => stores[i % 3]!.reserve([s], amount(10), 60_000)),
    );

    expect(outcomes.filter((o) => o.ok)).toHaveLength(10);
    await expect(stores[0]!.read(s)).resolves.toMatchObject({ reserved: amount(100) });
  });

  it('shares a budget between processes on one prefix, and separates other prefixes', async ({
    redis,
    newConnection,
  }) => {
    const prefix = uniquePrefix('us');
    const a = redisUsageStore(redis, { keyPrefix: prefix });
    const b = redisUsageStore(newConnection(), { keyPrefix: prefix });
    const other = redisUsageStore(newConnection(), { keyPrefix: uniquePrefix('us') });
    const s = scope('shared', { limit: 100 });

    const held = await a.reserve([s], amount(60), 60_000);
    if (held.ok) await a.commit(held.id, amount(60));

    expect((await b.reserve([s], amount(60), 60_000)).ok).toBe(false);
    expect((await other.reserve([s], amount(60), 60_000)).ok).toBe(true);
  });

  it('returns every expired reservation in one pass, not only the first 100', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const s = scope('many', { limit: 120 });

    for (let i = 0; i < 120; i++) await store.reserve([s], amount(1), 100);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await store.reserve([s], amount(120), 60_000)).ok).toBe(true);
  });

  it('returns a reservation that was never settled once its ttl passes', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const s = scope('lost', { limit: 100 });

    await store.reserve([s], amount(80), 1000);
    expect((await store.reserve([s], amount(80), 60_000)).ok).toBe(false);

    await waitUntil(async () => (await store.reserve([s], amount(80), 60_000)).ok, {
      timeoutMs: 3000,
    });
  });

  it('still records the spend of a call that settles after its reservation expired', async ({
    redis,
  }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const s = scope('late');

    const held = await store.reserve([s], amount(80), 100);
    await waitUntil(async () => (await store.read(s)).reserved.nanoUsd === 0);
    if (held.ok) await store.commit(held.id, amount(80));

    await expect(store.read(s)).resolves.toEqual({ spent: amount(80), reserved: amount(0) });

    // A second settle of the same id adds nothing.
    if (held.ok) await store.commit(held.id, amount(80));
    await expect(store.read(s)).resolves.toEqual({ spent: amount(80), reserved: amount(0) });
  });

  it('forgets an expired reservation once it is released', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });
    const s = scope('late-release');

    const held = await store.reserve([s], amount(80), 100);
    await waitUntil(async () => (await store.read(s)).reserved.nanoUsd === 0);
    if (held.ok) {
      await store.release(held.id);
      await store.commit(held.id, amount(80));
    }

    await expect(store.read(s)).resolves.toEqual({ spent: amount(0), reserved: amount(0) });
  });

  it('ignores a commit or release for an id it never saw', async ({ redis }) => {
    const store = redisUsageStore(redis, { keyPrefix: uniquePrefix('us') });

    await expect(store.commit('nope', amount(5))).resolves.toBeUndefined();
    await expect(store.release('nope')).resolves.toBeUndefined();
  });

  it('lets a scope expire after its window, with a day of grace', async ({ redis }) => {
    const prefix = uniquePrefix('us');
    const store = redisUsageStore(redis, { keyPrefix: prefix });
    const resetsAtMs = Date.now() + HOUR;

    await store.reserve([scope('ttl', { resetsAtMs })], amount(1), 60_000);

    const keys = await redis.keys(`{${prefix}}:s:*`);
    expect(keys).toHaveLength(1);
    const ttl = await redis.pttl(keys[0]!);
    expect(ttl).toBeGreaterThan(HOUR + 23 * HOUR);
    expect(ttl).toBeLessThanOrEqual(HOUR + 24 * HOUR);
  });

  it('puts every key under one hash tag, so a Cluster keeps them in one slot', async ({
    redis,
  }) => {
    const prefix = uniquePrefix('us');
    const store = redisUsageStore(redis, { keyPrefix: prefix });
    await store.reserve([scope('x'), scope('y')], amount(1), 60_000);

    const keys = await redis.keys(`*${prefix}*`);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const key of keys) expect(key.startsWith(`{${prefix}}:`)).toBe(true);
  });

  it('meters real calls through usageMiddleware, shared by two instances', async ({
    redis,
    newConnection,
  }) => {
    const prefix = uniquePrefix('us');
    const build = (connection: Redis) => {
      const client: LLMClient = {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: 'ok' } }],
              usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
              model: 'gpt-6-sol',
            }),
          },
        },
      };
      const store: UsageStore = redisUsageStore(connection, { keyPrefix: prefix });
      return new VernLLM({
        client,
        model: 'gpt-6-sol',
        maxRetries: 0,
        logger: 'silent',
        defaultMaxTokens: 50,
        middleware: [
          usageMiddleware({
            prices: { 'gpt-6-sol': { input: 2, output: 10 } },
            pricesAsOf: new Date().toISOString().slice(0, 10),
            attribute: ['tenantId'],
            budgets: [{ key: 'tenantId', limitTokens: 120, per: 'day' }],
            store,
            logger: 'silent',
          }),
        ],
      });
    };
    const a = build(redis);
    const b = build(newConnection());
    const tenant = `acme-${prefix}`;
    const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: tenant } };

    await expect(a.call(call)).resolves.toBe('ok');
    // 100 tokens are spent, so another process's call no longer fits in 120.
    await expect(b.call(call)).rejects.toSatisfy(
      (error) => error instanceof LLMError && error.code === 'budget_exceeded',
    );
  });
});
