import { describe, expect, it, vi } from 'vitest';

import { type CacheAdapter } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../helpers.js';

import type { InternalCacheParams } from '../../src/internal/cache.utils.js';

/**
 * `runCached` is a private implementation primitive backing the public
 * `cachedCall()`. This test exercises it directly rather than through `any`.
 */
type TestableVernLLM = Omit<VernLLM, 'runCached'> & {
  runCached: <T>(params: InternalCacheParams<T>) => Promise<T>;
};

function asTestable(llm: VernLLM): TestableVernLLM {
  return llm as unknown as TestableVernLLM;
}

describe('runCached workflow integration', () => {
  it('does not call underlying function after cache hit', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client,
      model: 'test',
    });

    const fn = vi.fn(async () => ({
      result: 'value',
    }));

    const first = await asTestable(llm).runCached({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });

    const second = await asTestable(llm).runCached({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });

    expect(first).toEqual(second);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('allows deleting a cached entry so the next call recomputes', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true }), jsonResponse({ ok: false })]);

    const llm = new VernLLM({
      client,
      model: 'test',
    });

    const fn = vi
      .fn()
      .mockResolvedValueOnce({ result: 'first' })
      .mockResolvedValueOnce({ result: 'second' });

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

  it('does not fail when cache adapter does not implement delete', async () => {
    const cache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: vi.fn(async () => {}),
    };

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
      cache,
    });

    await expect(llm.deleteCache('k1')).resolves.toBeUndefined();
  });
});
