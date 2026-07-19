import { describe, it, expect, vi } from 'vitest';

import { InMemoryCacheAdapter, type CacheAdapter } from '../../src/types.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from './../helpers.js';

describe('InMemoryCacheAdapter', () => {
  it('returns null for a missing key', async () => {
    const cache = new InMemoryCacheAdapter();
    expect(await cache.get('missing')).toBeNull();
  });

  it('round-trips a value within its TTL', async () => {
    const cache = new InMemoryCacheAdapter<{ a: number }>();
    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get('k')).toEqual({ a: 1 });
  });

  it('expires a value after its TTL', async () => {
    vi.useFakeTimers();
    const cache = new InMemoryCacheAdapter<number>();
    await cache.set('k', 42, 1); // 1 second TTL
    vi.advanceTimersByTime(1001);
    expect(await cache.get('k')).toBeNull();
    vi.useRealTimers();
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
    expect(await cache.get('k1')).toEqual({ ok: true });
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
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error('cache unavailable');
      }),
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
