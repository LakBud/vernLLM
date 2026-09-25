import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  type CacheAdapter,
  InMemoryCacheAdapter,
  NormalizedCacheAdapter,
  TieredCacheAdapter,
  LLMError,
} from '../../../../../src/types/index.js';
import { VernLLM } from '../../../../../src/vernLLM.js';
import { asTestable, createMockClient, jsonResponse } from '../../../../helpers.js';

describe('InMemoryCacheAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a miss for a missing key', async () => {
    const cache = new InMemoryCacheAdapter();
    expect(await cache.get('missing')).toEqual({ hit: false, value: null });
  });

  it('round-trips a value within its TTL', async () => {
    const cache = new InMemoryCacheAdapter<{ a: number }>();
    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get('k')).toEqual({ hit: true, value: { a: 1 } });
  });

  it('expires a value after its TTL', async () => {
    vi.useFakeTimers();
    const cache = new InMemoryCacheAdapter<number>();

    await cache.set('k', 42, 1); // 1 second TTL
    vi.advanceTimersByTime(1001);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('deletes a cached value', async () => {
    const cache = new InMemoryCacheAdapter();

    await cache.set('k', { value: true }, 60);
    await cache.delete('k');

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('evicts the oldest entries when max size is exceeded', async () => {
    const cache = new InMemoryCacheAdapter<number>(2);

    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.set('c', 3, 60);

    expect(await cache.get('a')).toEqual({ hit: false, value: null });
    expect(await cache.get('b')).toEqual({ hit: true, value: 2 });
    expect(await cache.get('c')).toEqual({ hit: true, value: 3 });
  });

  it('returns a copy on every hit, so mutating one result leaves the cache intact', async () => {
    const cache = new InMemoryCacheAdapter<{ items: string[] }>();
    await cache.set('k', { items: ['a'] }, 60);

    const first = await cache.get('k');
    first.value?.items.push('poisoned');

    expect(await cache.get('k')).toEqual({ hit: true, value: { items: ['a'] } });
  });

  it('stores a copy, so mutating the written value after set leaves the cache intact', async () => {
    const cache = new InMemoryCacheAdapter<{ items: string[] }>();
    const value = { items: ['a'] };

    await cache.set('k', value, 60);
    value.items.push('poisoned');

    expect(await cache.get('k')).toEqual({ hit: true, value: { items: ['a'] } });
  });

  it('does not store a value holding a function, instead of sharing it by reference', async () => {
    const cache = new InMemoryCacheAdapter<{ fn: () => number }>();

    await cache.set('k', { fn: () => 1 }, 60);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('never hands back a class instance stripped of its prototype', async () => {
    class Money {
      constructor(readonly cents: number) {}
      format(): string {
        return `$${(this.cents / 100).toFixed(2)}`;
      }
    }
    const cache = new InMemoryCacheAdapter<{ total: Money }>();

    await cache.set('k', { total: new Money(250) }, 60);
    const result = await cache.get('k');

    // Not cached at all, rather than a hit whose `total.format` is missing.
    expect(result).toEqual({ hit: false, value: null });
  });

  it('drops the older value when a key is rewritten with a value it cannot copy', async () => {
    const cache = new InMemoryCacheAdapter<unknown>();

    await cache.set('k', { ok: true }, 60);
    await cache.set('k', { fn: () => 1 }, 60);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('copies built-ins structuredClone recreates with their own type', async () => {
    const cache = new InMemoryCacheAdapter<unknown>();
    const value = {
      at: new Date(0),
      pattern: /a+/g,
      tags: new Set(['x']),
      counts: new Map([['a', 1]]),
      bytes: new Uint8Array([1, 2]),
      bare: Object.assign(Object.create(null) as object, { n: 1 }),
      list: [1, 'two', null, undefined, 3n],
    };

    await cache.set('k', value, 60);
    const { hit, value: copy } = await cache.get('k');

    expect(hit).toBe(true);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect((copy as typeof value).at).toBeInstanceOf(Date);
    expect((copy as typeof value).counts).toBeInstanceOf(Map);
  });

  it('copies a value with a cycle', async () => {
    const cache = new InMemoryCacheAdapter<Record<string, unknown>>();
    const value: Record<string, unknown> = { name: 'loop' };
    value.self = value;

    await cache.set('k', value, 60);
    const copy = (await cache.get('k')).value!;

    expect(copy.self).toBe(copy);
  });

  it.each([
    ['a symbol value', { s: Symbol('x') }],
    ['a symbol key', { [Symbol('x')]: 1 }],
    ['an accessor', Object.defineProperty({}, 'v', { get: () => 1, enumerable: true })],
    ['a class instance inside a Map', { m: new Map([['k', new (class Box {})()]]) }],
    ['a class instance as a Map key', { m: new Map([[new (class Key {})(), 1]]) }],
    ['a function inside a Set', { s: new Set([() => 1]) }],
  ])('does not store a value holding %s', async (_, value) => {
    const cache = new InMemoryCacheAdapter<unknown>();

    await cache.set('k', value, 60);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -5],
  ])('stores nothing for a %s ttl instead of an entry that never expires', async (_, ttl) => {
    vi.useFakeTimers();
    const cache = new InMemoryCacheAdapter<number>();

    await cache.set('k', 1, ttl as number);
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('drops the older value when a key is rewritten with an invalid ttl', async () => {
    const cache = new InMemoryCacheAdapter<number>();

    await cache.set('k', 1, 60);
    await cache.set('k', 2, Number.NaN);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('removes expired entries from the store on the next write', async () => {
    vi.useFakeTimers();
    const cache = new InMemoryCacheAdapter<number>();

    await cache.set('old', 1, 1);
    vi.advanceTimersByTime(1_001);
    await cache.set('new', 2, 60);

    const store = (cache as unknown as { store: Map<string, unknown> }).store;
    expect(store.has('old')).toBe(false);
    expect(store.has('new')).toBe(true);
  });

  it('keeps an Infinity ttl entry until it is deleted or evicted', async () => {
    vi.useFakeTimers();
    const cache = new InMemoryCacheAdapter<number>();

    await cache.set('k', 1, Infinity);
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);

    expect(await cache.get('k')).toEqual({ hit: true, value: 1 });
  });
});

describe('NormalizedCacheAdapter', () => {
  it('treats keys that differ only in outer whitespace as the same entry', async () => {
    const cache = new NormalizedCacheAdapter<string>();

    await cache.set('  What is the capital of France?  ', 'Paris', 60);

    expect(await cache.get('What is the capital of France?')).toEqual({
      hit: true,
      value: 'Paris',
    });
    expect(await cache.get('\n\tWhat is the capital of France?\n')).toEqual({
      hit: true,
      value: 'Paris',
    });
  });

  it('resolveKey returns the normalized key', async () => {
    const cache = new NormalizedCacheAdapter<string>();
    expect(await cache.resolveKey?.('  Hello,  World!  ')).toBe('Hello,  World!');
  });

  it('deletes through to the wrapped adapter using the normalized key', async () => {
    const cache = new NormalizedCacheAdapter<string>();

    await cache.set('Hello World', 'v', 60);
    await cache.delete('  Hello World  ');

    expect(await cache.get('Hello World')).toEqual({ hit: false, value: null });
  });

  it('wraps a custom inner adapter instead of the default InMemoryCacheAdapter', async () => {
    const inner = new InMemoryCacheAdapter<string>();
    const setSpy = vi.spyOn(inner, 'set');
    const cache = new NormalizedCacheAdapter<string>(inner);

    await cache.set(' Hello World ', 'v', 60);

    expect(setSpy).toHaveBeenCalledWith('Hello World', 'v', 60);
  });

  it('never gives prompts that differ in an operator the same entry', async () => {
    const cache = new NormalizedCacheAdapter<string>();

    await cache.set('What is 2+2?', '4', 60);

    expect(await cache.get('What is 2-2?')).toEqual({ hit: false, value: null });
    expect(await cache.get('What is 2*2?')).toEqual({ hit: false, value: null });
    expect(await cache.resolveKey?.('2+2')).not.toBe(await cache.resolveKey?.('2-2'));
  });

  it('keeps case, punctuation, and inner whitespace in the key', async () => {
    const cache = new NormalizedCacheAdapter<string>();

    expect(await cache.resolveKey?.('Polish')).not.toBe(await cache.resolveKey?.('polish'));
    expect(await cache.resolveKey?.('done.')).not.toBe(await cache.resolveKey?.('done?'));
    // Indentation is meaningful in code prompts.
    expect(await cache.resolveKey?.('if x:\n  y\nz')).not.toBe(
      await cache.resolveKey?.('if x:\n  y\n  z'),
    );
  });

  it('matches keys that differ only in line ending style or Unicode composition', async () => {
    const cache = new NormalizedCacheAdapter<string>();

    expect(await cache.resolveKey?.('a\r\nb\rc')).toBe('a\nb\nc');
    // "é" precomposed vs "e" plus a combining acute accent.
    expect(await cache.resolveKey?.('caf\u00e9')).toBe(await cache.resolveKey?.('cafe\u0301'));
  });
});

describe('TieredCacheAdapter', () => {
  it('reads from L1 first without touching L2 on an L1 hit', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const l2GetSpy = vi.spyOn(l2, 'get');
    const cache = new TieredCacheAdapter(l1, l2);

    await l1.set('k', 'from-l1', 60);

    expect(await cache.get('k')).toEqual({ hit: true, value: 'from-l1' });
    expect(l2GetSpy).not.toHaveBeenCalled();
  });

  it('falls back to L2 on an L1 miss and backfills L1', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2);

    await l2.set('k', 'from-l2', 60);

    expect(await cache.get('k')).toEqual({ hit: true, value: 'from-l2' });
    // L1 should now be populated so the next read skips L2 entirely
    expect(await l1.get('k')).toEqual({ hit: true, value: 'from-l2' });
  });

  it('returns a miss when neither tier has the key', async () => {
    const cache = new TieredCacheAdapter(new InMemoryCacheAdapter(), new InMemoryCacheAdapter());
    expect(await cache.get('missing')).toEqual({ hit: false, value: null });
  });

  it('writes to both tiers on set', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2);

    await cache.set('k', 'v', 60);

    expect(await l1.get('k')).toEqual({ hit: true, value: 'v' });
    expect(await l2.get('k')).toEqual({ hit: true, value: 'v' });
  });

  it('deletes from both tiers', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2);

    await cache.set('k', 'v', 60);
    await cache.delete('k');

    expect(await l1.get('k')).toEqual({ hit: false, value: null });
    expect(await l2.get('k')).toEqual({ hit: false, value: null });
  });

  it('backfills L1 when L2 has a cached null value', async () => {
    const l1 = new InMemoryCacheAdapter<null>();
    const l2 = new InMemoryCacheAdapter<null>();
    const cache = new TieredCacheAdapter(l1, l2);

    await l2.set('k', null, 60);

    expect(await cache.get('k')).toEqual({ hit: true, value: null });

    expect(await l1.get('k')).toEqual({ hit: true, value: null });
  });

  it('forwards resolveKey to L1 when L1 implements it', async () => {
    const l1 = new NormalizedCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2);

    expect(await cache.resolveKey?.('  Hello,  World!  ')).toBe('Hello,  World!');
  });

  it('falls back to L2 resolveKey when L1 has none', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new NormalizedCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2);

    expect(await cache.resolveKey?.('  Hello,  World!  ')).toBe('Hello,  World!');
  });

  it('returns the key unchanged when neither tier implements resolveKey', async () => {
    const cache = new TieredCacheAdapter(new InMemoryCacheAdapter(), new InMemoryCacheAdapter());
    expect(await cache.resolveKey?.('Some Key')).toBe('Some Key');
  });

  it('prefers L1 resolveKey over L2 when both implement it', async () => {
    const l1: CacheAdapter<string> = {
      get: async () => ({ hit: false, value: null }),
      set: async () => {},
      resolveKey: async () => 'from-l1',
    };
    const l2: CacheAdapter<string> = {
      get: async () => ({ hit: false, value: null }),
      set: async () => {},
      resolveKey: async () => 'from-l2',
    };
    const cache = new TieredCacheAdapter(l1, l2);

    expect(await cache.resolveKey?.('anything')).toBe('from-l1');
  });
});

describe('TieredCacheAdapter expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps the L1 ttl at the L2 ttl on set, so L1 never outlives L2', async () => {
    vi.useFakeTimers();
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2, 60);

    await cache.set('k', 'v', 10);
    vi.advanceTimersByTime(10_001);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('still uses the shorter l1Ttl when it is below the L2 ttl', async () => {
    vi.useFakeTimers();
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const setSpy = vi.spyOn(l1, 'set');
    const cache = new TieredCacheAdapter(l1, l2, 5);

    await cache.set('k', 'v', 60);

    expect(setSpy).toHaveBeenCalledWith('k', 'v', 5);
  });

  it('caps a promoted L1 entry at the time L2 has left for a key it wrote', async () => {
    vi.useFakeTimers();
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2, 60);

    await cache.set('k', 'v', 100);
    vi.advanceTimersByTime(90_000);
    // L1 expired at 60s, so this read promotes from L2 with 10s left.
    await l1.delete('k');
    expect(await cache.get('k')).toEqual({ hit: true, value: 'v' });

    vi.advanceTimersByTime(10_001);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
    expect(await l1.get('k')).toEqual({ hit: false, value: null });
  });

  it('promotes an entry another process wrote with l1Ttl, since its L2 expiry is unknown', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const setSpy = vi.spyOn(l1, 'set');
    const cache = new TieredCacheAdapter(l1, l2, 30);

    await l2.set('k', 'v', 3600);
    await cache.get('k');

    expect(setSpy).toHaveBeenCalledWith('k', 'v', 30);
  });

  it('forgets a tracked expiry on delete', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const setSpy = vi.spyOn(l1, 'set');
    const cache = new TieredCacheAdapter(l1, l2);

    await cache.set('k', 'v', 5);
    await cache.delete('k');
    await l2.set('k', 'w', 3600);
    await cache.get('k');

    expect(setSpy).toHaveBeenLastCalledWith('k', 'w', 60);
  });

  it('passes a NaN ttl through to both tiers, which then store nothing', async () => {
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const cache = new TieredCacheAdapter(l1, l2, 60);

    await cache.set('k', 'v', Number.NaN);

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('stops tracking an expiry once it has passed', async () => {
    vi.useFakeTimers();
    const cache = new TieredCacheAdapter<number>(
      new InMemoryCacheAdapter<number>(),
      new InMemoryCacheAdapter<number>(),
    );

    await cache.set('short', 1, 1);
    vi.advanceTimersByTime(1_001);
    await cache.set('long', 2, 60);

    const tracked = (cache as unknown as { l2ExpiresAt: Map<string, number> }).l2ExpiresAt;
    expect(tracked.has('short')).toBe(false);
    expect(tracked.has('long')).toBe(true);
  });

  it("treats an L2 hit on a key whose tracked write expired as another process's entry", async () => {
    vi.useFakeTimers();
    const l1 = new InMemoryCacheAdapter<string>();
    const l2 = new InMemoryCacheAdapter<string>();
    const setSpy = vi.spyOn(l1, 'set');
    const cache = new TieredCacheAdapter(l1, l2, 30);

    await cache.set('k', 'mine', 5);
    vi.advanceTimersByTime(6_000);
    // Another process rewrote the key in L2 after this process's write expired.
    await l2.set('k', 'theirs', 3600);

    expect(await cache.get('k')).toEqual({ hit: true, value: 'theirs' });
    expect(setSpy).toHaveBeenLastCalledWith('k', 'theirs', 30);

    const tracked = (cache as unknown as { l2ExpiresAt: Map<string, number> }).l2ExpiresAt;
    expect(tracked.has('k')).toBe(false);
  });

  it('prunes by expiry, not write order, and never lets a stale record remove a newer one', async () => {
    vi.useFakeTimers();
    const noop = { get: async () => ({ hit: false, value: null }), set: async () => {} };
    const cache = new TieredCacheAdapter<number>(noop, noop);
    const tracked = (cache as unknown as { l2ExpiresAt: Map<string, number> }).l2ExpiresAt;

    await cache.set('long', 1, 3600); // written first, expires last
    await cache.set('short', 2, 1);
    await cache.set('rewritten', 3, 1);
    await cache.set('rewritten', 4, 3600); // its old 1s record is now stale

    vi.advanceTimersByTime(1_001);
    await cache.set('trigger', 5, 3600);

    expect(tracked.has('short')).toBe(false);
    expect(tracked.has('long')).toBe(true);
    expect(tracked.has('rewritten')).toBe(true);
  });

  it('prunes exactly the expired records across many mixed ttls, step by step', async () => {
    vi.useFakeTimers();
    const noop = { get: async () => ({ hit: false, value: null }), set: async () => {} };
    const cache = new TieredCacheAdapter<number>(noop, noop);
    const tracked = (cache as unknown as { l2ExpiresAt: Map<string, number> }).l2ExpiresAt;
    const start = Date.now();

    // A fixed, shuffled spread of ttls from 1s to 40s.
    const ttls = Array.from({ length: 40 }, (_, i) => ((i * 17) % 40) + 1);
    for (const [i, ttl] of ttls.entries()) await cache.set(`k${i}`, i, ttl);

    for (const elapsed of [5, 12, 25, 39]) {
      vi.setSystemTime(start + elapsed * 1_000 + 1);
      await cache.set('probe', 0, 3600);

      const expected = ttls.flatMap((ttl, i) => (ttl > elapsed ? [`k${i}`] : []));
      expect([...tracked.keys()].filter((k) => k !== 'probe').sort()).toEqual(expected.sort());
    }
  });

  it('keeps the expiry heap bounded when the same keys are rewritten over and over', async () => {
    const noop = { get: async () => ({ hit: false, value: null }), set: async () => {} };
    const cache = new TieredCacheAdapter<number>(noop, noop);

    for (let i = 0; i < 5_000; i++) await cache.set(`k${i % 10}`, i, 3600);

    const heap = (cache as unknown as { expiryHeap: unknown[] }).expiryHeap;
    expect(heap.length).toBeLessThanOrEqual(2 * 10 + 64 + 1);
  });

  it('bounds the number of tracked expiries', async () => {
    const cache = new TieredCacheAdapter<number>(
      { get: async () => ({ hit: false, value: null }), set: async () => {} },
      { get: async () => ({ hit: false, value: null }), set: async () => {} },
    );

    for (let i = 0; i < 10_050; i++) await cache.set(`k${i}`, i, 3600);

    const tracked = (cache as unknown as { l2ExpiresAt: Map<string, number> }).l2ExpiresAt;
    expect(tracked.size).toBe(10_000);
    expect(tracked.has('k0')).toBe(false);
    expect(tracked.has('k10049')).toBe(true);
  });
});

describe('VernLLM.runCached (internal)', () => {
  it('calls fn and caches the result on a miss', async () => {
    const cache = new InMemoryCacheAdapter();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', cache });
    const fn = vi.fn(() => llm.call({ systemPrompt: 's', userContent: 'u' }));

    const result = await asTestable(llm).runCached({ cacheKey: 'k1', ttl: 60, fn });
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await cache.get('k1')).toEqual({ hit: true, value: { ok: true } });
  });

  it('returns the cached value on a hit without calling fn again', async () => {
    const cache = new InMemoryCacheAdapter();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', cache });
    const fn = vi.fn(() => llm.call({ systemPrompt: 's', userContent: 'u' }));

    await asTestable(llm).runCached({ cacheKey: 'k1', ttl: 60, fn });
    await asTestable(llm).runCached({ cacheKey: 'k1', ttl: 60, fn });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls reserveUsage before fn and does not call refundUsage on success', async () => {
    const order: string[] = [];
    const reserveUsage = vi.fn(async () => {
      order.push('reserve');
    });
    const refundUsage = vi.fn(async () => {
      order.push('refund');
    });
    const fn = vi.fn(async () => {
      order.push('fn');
      return 'result';
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage });

    expect(order).toEqual(['reserve', 'fn']);
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('normalizes reserveUsage failures as quota_exceeded LLMError and preserves the original cause', async () => {
    const originalError = new Error('quota backend unavailable');
    const reserveUsage = vi.fn(async () => {
      throw originalError;
    });
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => 'result');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    const error = await asTestable(llm)
      .runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage })
      .catch((err) => err);

    expect(error).toBeInstanceOf(LLMError);

    if (!(error instanceof LLMError)) {
      throw new Error('Expected LLMError');
    }

    expect(error.type).toBe('quota_exceeded');
    expect(error.message).toBe('quota backend unavailable');
    expect(error.cause).toBe(originalError);

    expect(fn).not.toHaveBeenCalled();
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('calls refundUsage when fn throws and reserveUsage succeeded first, and rethrows the original error', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => {
      throw new Error('fn failed');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
    ).rejects.toThrow('fn failed');
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('does not call refundUsage when fn throws and no reserveUsage was provided, nothing was reserved', async () => {
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => {
      throw new Error('fn failed');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, refundUsage }),
    ).rejects.toThrow('fn failed');
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('does not throw if refundUsage itself throws, original error still propagates', async () => {
    const fn = vi.fn(async () => {
      throw new Error('original failure');
    });
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn(async () => {
      throw new Error('refund also failed');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
    ).rejects.toThrow('original failure');
  });

  it('refunds and throws aborted, not the resolved value, when the signal aborts while an abort-insensitive fn is still in flight', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const controller = new AbortController();

    // Deliberately ignores the signal, unlike a well-behaved fn, resolves
    // successfully regardless of whether the caller aborted mid-flight.
    const fn = vi.fn(async () => {
      controller.abort();
      return 'stale result';
    });

    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      asTestable(llm).runCached({
        cacheKey: 'k',
        ttl: 60,
        fn,
        reserveUsage,
        refundUsage,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'aborted' });

    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('does not call refundUsage when reserveUsage itself rejects (e.g. quota already exhausted)', async () => {
    const reserveUsage = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => 'result');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
    ).rejects.toThrow('quota exceeded');

    expect(fn).not.toHaveBeenCalled(); // never should have run, reservation failed first
    expect(refundUsage).not.toHaveBeenCalled(); // nothing was reserved, so nothing to refund
  });

  it('propagates reserveUsage failure directly without invoking refundUsage, even if refundUsage would also throw', async () => {
    const fn = vi.fn(async () => 'result');
    const reserveUsage = vi.fn(async () => {
      throw new Error('reserve failed');
    });
    const refundUsage = vi.fn(async () => {
      throw new Error('refund also throws');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
    ).rejects.toThrow('reserve failed'); // not masked by refund, because refund never runs

    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('does not call refundUsage for a coalesced caller whose own reserveUsage rejects, and does not affect the trigger', async () => {
    let resolveFn!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);

    let callCount = 0;
    const reserveUsage = vi.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error('quota exceeded'); // the coalesced caller is out of quota
    });
    const refundUsage = vi.fn();
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    const trigger = asTestable(llm).runCached({
      cacheKey: 'k',
      ttl: 60,
      fn,
      reserveUsage,
      refundUsage,
    });
    await Promise.resolve();
    const coalescedCaller = asTestable(llm).runCached({
      cacheKey: 'k',
      ttl: 60,
      fn,
      reserveUsage,
      refundUsage,
    });

    await expect(coalescedCaller).rejects.toThrow('quota exceeded');
    expect(refundUsage).not.toHaveBeenCalled(); // this caller's reservation never succeeded

    resolveFn('shared result');
    await expect(trigger).resolves.toBe('shared result'); // trigger is unaffected by the other caller's rejection
  });

  it('still returns the result if the cache write fails', async () => {
    const brokenCache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: vi.fn(async () => {
        throw new Error('cache unavailable');
      }),
      delete: vi.fn(async () => {}),
    };

    const fn = vi.fn(async () => 'result');

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
      cache: brokenCache,
    });

    await expect(asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn })).resolves.toBe('result');
  });

  it('does not reserve/refund usage when hooks are omitted', async () => {
    const fn = vi.fn(async () => 'result');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn })).resolves.toBe('result');
  });

  it('coalesces concurrent misses for the same cacheKey into a single fn() call', async () => {
    let resolveFn!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    const calls = [
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn }),
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn }),
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn }),
    ];

    for (let i = 0; i < 5; i++) await Promise.resolve(); // flush microtasks so all three reach the in-flight check
    expect(fn).toHaveBeenCalledTimes(1);

    resolveFn('shared result');
    const results = await Promise.all(calls);
    expect(results).toEqual(['shared result', 'shared result', 'shared result']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent misses with different cacheKeys when the adapter resolves them to the same key', async () => {
    // Simulates a semantic-cache adapter: any key containing "hello" is
    // treated as equivalent, regardless of exact wording.
    class FakeSemanticAdapter implements CacheAdapter<string> {
      private store = new Map<string, string>();

      async resolveKey(key: string): Promise<string> {
        return key.toLowerCase().includes('hello') ? 'canonical:hello' : key;
      }

      async get(key: string) {
        const value = this.store.get(key);
        return value === undefined ? { hit: false, value: null } : { hit: true, value };
      }

      async set(key: string, value: string) {
        this.store.set(key, value);
      }
    }

    let resolveFn!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);
    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
      cache: new FakeSemanticAdapter(),
    });

    // Three differently-worded but "semantically" equivalent prompts.
    const calls = [
      asTestable(llm).runCached({ cacheKey: 'Hello there', ttl: 60, fn }),
      asTestable(llm).runCached({ cacheKey: 'hello, friend!', ttl: 60, fn }),
      asTestable(llm).runCached({ cacheKey: 'HELLO world', ttl: 60, fn }),
    ];

    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1); // would be 3 without resolveKey

    resolveFn('shared result');
    const results = await Promise.all(calls);
    expect(results).toEqual(['shared result', 'shared result', 'shared result']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('propagates a coalesced fn() failure to every waiting caller', async () => {
    let rejectFn!: (err: Error) => void;
    const gate = new Promise<string>((_resolve, reject) => {
      rejectFn = reject;
    });
    const fn = vi.fn(() => gate);
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    const calls = [
      asTestable(llm)
        .runCached({ cacheKey: 'k', ttl: 60, fn })
        .catch((e) => e),
      asTestable(llm)
        .runCached({ cacheKey: 'k', ttl: 60, fn })
        .catch((e) => e),
    ];

    await Promise.resolve();
    rejectFn(new Error('shared failure'));

    const results = await Promise.all(calls);
    expect(fn).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r).toBeInstanceOf(Error);
      expect((r as Error).message).toBe('shared failure');
    }
  });

  it('reserves and refunds usage separately for each coalesced caller, tagged with coalesced: true/false', async () => {
    let resolveFn!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);
    const reserveCalls: boolean[] = [];
    const reserveUsage = vi.fn(async (info: { coalesced: boolean }) => {
      reserveCalls.push(info.coalesced);
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });
    const calls = [
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage }),
      asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage }),
    ];
    await Promise.resolve();
    resolveFn('result');
    await Promise.all(calls);
    expect(reserveUsage).toHaveBeenCalledTimes(2);
    expect(reserveCalls.sort()).toEqual([false, true]); // one trigger, one coalesced
  });

  it('reserves and refunds usage separately for each coalesced caller on failure, tagged with coalesced: true/false', async () => {
    let rejectFn!: (err: Error) => void;
    const gate = new Promise<string>((_resolve, reject) => {
      rejectFn = reject;
    });
    const fn = vi.fn(() => gate);
    const reserveUsage = vi.fn();
    const refundCalls: boolean[] = [];
    const refundUsage = vi.fn(async (info: { coalesced: boolean }) => {
      refundCalls.push(info.coalesced);
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });
    const calls = [
      asTestable(llm)
        .runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage })
        .catch(() => {}),
      asTestable(llm)
        .runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage })
        .catch(() => {}),
    ];
    await Promise.resolve();
    rejectFn(new Error('shared failure'));
    await Promise.all(calls);
    expect(refundUsage).toHaveBeenCalledTimes(2);
    expect(refundCalls.sort()).toEqual([false, true]);
  });

  it('cleans up the in-flight entry after a successful call, allowing a fresh trigger later', async () => {
    const fn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await asTestable(llm).runCached({ cacheKey: 'k', ttl: 0, fn });
    // A fresh call after the first settled and the cache entry doesn't
    // apply (ttl 0) should trigger fn() again, proving the in-flight
    // entry for 'k' was cleaned up rather than reused indefinitely
    const result = await asTestable(llm).runCached({ cacheKey: 'k', ttl: 0, fn });

    expect(result).toBe('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cleans up the in-flight entry after a failed call, allowing a retry to trigger fn() again', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce('recovered');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn })).rejects.toThrow(
      'first failure',
    );
    // If the in-flight entry weren't cleaned up, this second call would
    // incorrectly reuse the failed (and by now settled) promise instead of
    // triggering a fresh fn() call
    const result = await asTestable(llm).runCached({ cacheKey: 'k', ttl: 60, fn });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('passes each coalesced caller its own signal in reserveUsage and refundUsage hooks', async () => {
    let resolveFn!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });

    const fn = vi.fn(() => gate);

    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
    });

    const trigger = asTestable(llm).runCached({
      cacheKey: 'k',
      ttl: 60,
      fn,
      signal: controllerA.signal,
      reserveUsage,
      refundUsage,
    });

    await Promise.resolve();

    const coalesced = asTestable(llm).runCached({
      cacheKey: 'k',
      ttl: 60,
      fn,
      signal: controllerB.signal,
      reserveUsage,
      refundUsage,
    });

    resolveFn('shared result');

    await Promise.all([trigger, coalesced]);

    expect(reserveUsage).toHaveBeenCalledTimes(2);

    expect(reserveUsage).toHaveBeenNthCalledWith(1, {
      coalesced: false,
      signal: controllerA.signal,
    });

    expect(reserveUsage).toHaveBeenNthCalledWith(2, {
      coalesced: true,
      signal: controllerB.signal,
    });
  });

  it('rejects an already-aborted coalesced caller without reserving/refunding usage, and does not affect the shared fn or trigger caller', async () => {
    let resolveFn!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });

    const fn = vi.fn(() => gate);

    const triggerController = new AbortController();
    const coalescedController = new AbortController();

    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
    });

    const trigger = asTestable(llm).runCached({
      cacheKey: 'k',
      ttl: 60,
      fn,
      signal: triggerController.signal,
      reserveUsage,
      refundUsage,
    });

    await Promise.resolve();

    const coalesced = asTestable(llm).runCached({
      cacheKey: 'k',
      ttl: 60,
      fn,
      signal: coalescedController.signal,
      reserveUsage,
      refundUsage,
    });

    await Promise.resolve();

    coalescedController.abort();

    await expect(coalesced).rejects.toMatchObject({
      type: 'aborted',
    });

    // The signal is already aborted by the time this coalesced caller's
    // withReservedUsage runs, so it short-circuits before ever reserving,
    // meaning there's nothing to refund either.
    expect(reserveUsage).not.toHaveBeenCalledWith({
      coalesced: true,
      signal: coalescedController.signal,
    });
    expect(refundUsage).not.toHaveBeenCalledWith({
      coalesced: true,
      signal: coalescedController.signal,
    });

    expect(fn).toHaveBeenCalledTimes(1);

    resolveFn('shared result');

    await expect(trigger).resolves.toBe('shared result');

    expect(refundUsage).not.toHaveBeenCalled();
  });
});

describe('VernLLM.deleteCache', () => {
  it('deletes a cache entry through the configured adapter', async () => {
    const deletedKeys: string[] = [];

    const cache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: vi.fn(async () => {}),
      delete: vi.fn(async (key: string) => {
        deletedKeys.push(key);
      }),
    };

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
      cache,
    });

    await llm.deleteCache('k1');

    expect(deletedKeys).toEqual(['k1']);
  });

  it('deletes a cache entry from the in-memory adapter', async () => {
    const cache = new InMemoryCacheAdapter();

    await cache.set('k1', { value: true }, 60);

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
      cache,
    });

    await llm.deleteCache('k1');

    expect(await cache.get('k1')).toEqual({ hit: false, value: null });
  });

  it('recomputes after deleting cached value', async () => {
    const cache = new InMemoryCacheAdapter();

    const fn = vi
      .fn()
      .mockResolvedValueOnce({ result: 'first' })
      .mockResolvedValueOnce({ result: 'second' });

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
      cache,
    });

    const first = await asTestable(llm).runCached({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });

    await llm.deleteCache('abc');

    const second = await asTestable(llm).runCached({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });

    expect(first).toEqual({ result: 'first' });
    expect(second).toEqual({ result: 'second' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
