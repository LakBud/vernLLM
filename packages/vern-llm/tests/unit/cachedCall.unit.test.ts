import { describe, it, expect, vi } from 'vitest';

import { type CacheAdapter, InMemoryCacheAdapter } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from './../helpers.js';

describe('InMemoryCacheAdapter', () => {
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
    vi.useRealTimers();
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
});

describe('VernLLM.cachedCall', () => {
  it('calls fn and caches the result on a miss', async () => {
    const cache = new InMemoryCacheAdapter();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', cache });
    const fn = vi.fn(() => llm.call({ systemPrompt: 's', userContent: 'u' }));

    const result = await llm.cachedCall({ cacheKey: 'k1', ttl: 60, fn });
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await cache.get('k1')).toEqual({ hit: true, value: { ok: true } });
  });

  it('returns the cached value on a hit without calling fn again', async () => {
    const cache = new InMemoryCacheAdapter();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', cache });
    const fn = vi.fn(() => llm.call({ systemPrompt: 's', userContent: 'u' }));

    await llm.cachedCall({ cacheKey: 'k1', ttl: 60, fn });
    await llm.cachedCall({ cacheKey: 'k1', ttl: 60, fn });

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

    await llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage });

    expect(order).toEqual(['reserve', 'fn']);
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('calls refundUsage when fn throws, and rethrows the original error', async () => {
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => {
      throw new Error('fn failed');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, refundUsage })).rejects.toThrow(
      'fn failed',
    );
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('does not throw if refundUsage itself throws — original error still propagates', async () => {
    const fn = vi.fn(async () => {
      throw new Error('original failure');
    });
    const refundUsage = vi.fn(async () => {
      throw new Error('refund also failed');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, refundUsage })).rejects.toThrow(
      'original failure',
    );
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

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn })).resolves.toBe('result');
  });

  it('does not reserve/refund usage when hooks are omitted', async () => {
    const fn = vi.fn(async () => 'result');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn })).resolves.toBe('result');
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

    const first = await llm.cachedCall({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });

    await llm.deleteCache('abc');

    const second = await llm.cachedCall({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });

    expect(first).toEqual({ result: 'first' });
    expect(second).toEqual({ result: 'second' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('deletes an existing key', async () => {
    const cache = new InMemoryCacheAdapter();

    await cache.set('k', { a: 1 }, 60);
    await cache.delete('k');

    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });
});
