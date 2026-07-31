import { describe, it, expect, vi } from 'vitest';

import { type CacheAdapter, InMemoryCacheAdapter, LLMError } from '../../src/types/index.js';
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

  it('normalizes reserveUsage failures as quota_exceeded LLMError and preserves the original cause', async () => {
    const originalError = new Error('quota backend unavailable');
    const reserveUsage = vi.fn(async () => {
      throw originalError;
    });
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => 'result');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    const error = await llm
      .cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage })
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
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
    ).rejects.toThrow('fn failed');
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('does not call refundUsage when fn throws and no reserveUsage was provided — nothing was reserved', async () => {
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => {
      throw new Error('fn failed');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, refundUsage })).rejects.toThrow(
      'fn failed',
    );
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('does not throw if refundUsage itself throws — original error still propagates', async () => {
    const fn = vi.fn(async () => {
      throw new Error('original failure');
    });
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn(async () => {
      throw new Error('refund also failed');
    });
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
    ).rejects.toThrow('original failure');
  });

  it('does not call refundUsage when reserveUsage itself rejects (e.g. quota already exhausted)', async () => {
    const reserveUsage = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const refundUsage = vi.fn();
    const fn = vi.fn(async () => 'result');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
    ).rejects.toThrow('quota exceeded');

    expect(fn).not.toHaveBeenCalled(); // never should have run — reservation failed first
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
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }),
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

    const trigger = llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage });
    await Promise.resolve();
    const coalescedCaller = llm.cachedCall({
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

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn })).resolves.toBe('result');
  });

  it('does not reserve/refund usage when hooks are omitted', async () => {
    const fn = vi.fn(async () => 'result');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn })).resolves.toBe('result');
  });

  it('coalesces concurrent misses for the same cacheKey into a single fn() call', async () => {
    let resolveFn!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    const calls = [
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn }),
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn }),
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn }),
    ];

    for (let i = 0; i < 5; i++) await Promise.resolve(); // flush microtasks so all three reach the in-flight check
    expect(fn).toHaveBeenCalledTimes(1);

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
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn }).catch((e) => e),
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn }).catch((e) => e),
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
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage }),
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage }),
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
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }).catch(() => {}),
      llm.cachedCall({ cacheKey: 'k', ttl: 60, fn, reserveUsage, refundUsage }).catch(() => {}),
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

    await llm.cachedCall({ cacheKey: 'k', ttl: 0, fn });
    // A fresh call after the first settled and the cache entry doesn't
    // apply (ttl 0) should trigger fn() again, proving the in-flight
    // entry for 'k' was cleaned up rather than reused indefinitely
    const result = await llm.cachedCall({ cacheKey: 'k', ttl: 0, fn });

    expect(result).toBe('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cleans up the in-flight entry after a failed call, allowing a retry to trigger fn() again', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce('recovered');
    const llm = new VernLLM({ client: createMockClient([]).client, model: 'm' });

    await expect(llm.cachedCall({ cacheKey: 'k', ttl: 60, fn })).rejects.toThrow('first failure');
    // If the in-flight entry weren't cleaned up, this second call would
    // incorrectly reuse the failed (and by now settled) promise instead of
    // triggering a fresh fn() call
    const result = await llm.cachedCall({ cacheKey: 'k', ttl: 60, fn });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
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

describe('VernLLM.cachedLLMCall — reserveUsage/refundUsage dedup', () => {
  it('reserves and refunds exactly once when only the top-level hooks are provided', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const { client } = createMockClient([new Error('fail')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await llm
      .cachedLLMCall({
        cacheKey: 'k',
        ttl: 60,
        call: { systemPrompt: 's', userContent: 'u' },
        reserveUsage,
        refundUsage,
      })
      .catch(() => {});

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('ignores reserveUsage/refundUsage set on the inner call object — top-level hooks win, no double reservation', async () => {
    const outerReserve = vi.fn();
    const outerRefund = vi.fn();
    const innerReserve = vi.fn();
    const innerRefund = vi.fn();
    const { client } = createMockClient([new Error('fail')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await llm
      .cachedLLMCall({
        cacheKey: 'k',
        ttl: 60,
        call: {
          systemPrompt: 's',
          userContent: 'u',
          reserveUsage: innerReserve,
          refundUsage: innerRefund,
        },
        reserveUsage: outerReserve,
        refundUsage: outerRefund,
      })
      .catch(() => {});

    expect(outerReserve).toHaveBeenCalledTimes(1);
    expect(outerRefund).toHaveBeenCalledTimes(1);
    expect(innerReserve).not.toHaveBeenCalled();
    expect(innerRefund).not.toHaveBeenCalled();
  });
});
