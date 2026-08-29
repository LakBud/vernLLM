import { describe, it, expect, vi } from 'vitest';

import { CacheOrchestrator } from '../../../../src/internal/cache/cacheOrchestrator.js';
import { InMemoryCacheAdapter, type CacheAdapter } from '../../../../src/types/index.js';

import type { Logger } from '../../../../src/logger.js';
import type { StreamChunk } from '../../../../src/types/stream.js';

function silentLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of chunks) out.push(c);
  return out;
}

describe('CacheOrchestrator.runCached, joinInFlight/registerTrigger', () => {
  it('registerTrigger: a fresh miss runs fn() once and caches the result', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());
    const fn = vi.fn(async () => 'result');

    const result = await orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn });

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await cache.get('k')).toEqual({ hit: true, value: 'result' });
  });

  it('joinInFlight: a concurrent miss for the same key joins the trigger instead of calling fn again', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    let resolveFn!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);

    const trigger = orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn });
    await Promise.resolve();
    const joiner = orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn });

    resolveFn('shared');

    await expect(Promise.all([trigger, joiner])).resolves.toEqual(['shared', 'shared']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('joinInFlight reserves usage tagged coalesced: true for the joining caller, false for the trigger', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    let resolveFn!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);
    const reserved: boolean[] = [];
    const reserveUsage = vi.fn(async (info: { coalesced: boolean }) => {
      reserved.push(info.coalesced);
    });

    const trigger = orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage });
    await Promise.resolve();
    const joiner = orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn, reserveUsage });

    resolveFn('shared');
    await Promise.all([trigger, joiner]);

    expect(reserved.sort()).toEqual([false, true]);
  });

  it('a joiner does not call fn or duplicate the cache write once the trigger settles', async () => {
    const setSpy = vi.fn();
    const cache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: setSpy,
    };
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    let resolveFn!: (v: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });
    const fn = vi.fn(() => gate);

    const trigger = orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn });
    await Promise.resolve();
    const joiner = orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn });

    resolveFn('shared');
    await Promise.all([trigger, joiner]);

    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('a fresh miss after the in-flight entry has settled triggers fn() again (registry cleaned up)', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());
    const fn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await orchestrator.runCached({ cacheKey: 'k', ttl: 0, fn });
    const result = await orchestrator.runCached({ cacheKey: 'k', ttl: 0, fn });

    expect(result).toBe('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a cache hit short-circuits before ever consulting the in-flight registry', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', 'cached-value', 60);
    const orchestrator = new CacheOrchestrator(cache, silentLogger());
    const fn = vi.fn(async () => 'fresh');

    const result = await orchestrator.runCached({ cacheKey: 'k', ttl: 60, fn });

    expect(result).toBe('cached-value');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('CacheOrchestrator.runCachedStream, registerStreamTrigger', () => {
  function chunksOf(items: StreamChunk[]): AsyncIterable<StreamChunk> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of items) yield item;
      },
    };
  }

  it('miss: opens the stream once, relays its live chunks, and caches the settled finalResult', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());
    const openStream = vi.fn(async () => ({
      chunks: chunksOf([{ type: 'text-delta', delta: 'hi' }]),
      finalResult: Promise.resolve('hi'),
    }));

    const { chunks, finalResult } = await orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream },
      false,
    );

    expect(await drain(chunks)).toEqual([{ type: 'text-delta', delta: 'hi' }]);
    await expect(finalResult).resolves.toBe('hi');
    expect(openStream).toHaveBeenCalledTimes(1);
    expect(await cache.get('k')).toEqual({ hit: true, value: 'hi' });
  });

  it('registers the in-flight entry synchronously, before openStream resolves, so a concurrent miss joins it', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    let resolveOpen!: (v: {
      chunks: AsyncIterable<StreamChunk>;
      finalResult: Promise<string>;
    }) => void;
    const openGate = new Promise<{
      chunks: AsyncIterable<StreamChunk>;
      finalResult: Promise<string>;
    }>((resolve) => {
      resolveOpen = resolve;
    });
    const openStream = vi.fn(() => openGate);

    const triggerPromise = orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream },
      false,
    );
    // openStream hasn't resolved yet, but the in-flight entry should already be tracked.
    const joinerPromise = orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream: vi.fn() },
      false,
    );

    resolveOpen({
      chunks: chunksOf([{ type: 'text-delta', delta: 'live' }]),
      finalResult: Promise.resolve('live'),
    });

    const [trigger, joiner] = await Promise.all([triggerPromise, joinerPromise]);

    await expect(trigger.finalResult).resolves.toBe('live');
    await expect(joiner.finalResult).resolves.toBe('live');
    // The joiner's own openStream (a distinct mock) should never have run.
    expect(openStream).toHaveBeenCalledTimes(1);
  });

  it("a joiner gets a one-shot replay built once the trigger settles, not the trigger's live chunks object", async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    let resolveOpen!: (v: {
      chunks: AsyncIterable<StreamChunk>;
      finalResult: Promise<string>;
    }) => void;
    const openGate = new Promise<{
      chunks: AsyncIterable<StreamChunk>;
      finalResult: Promise<string>;
    }>((resolve) => {
      resolveOpen = resolve;
    });
    const openStream = vi.fn(() => openGate);

    const triggerPromise = orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream },
      false,
    );
    const joinerPromise = orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream: vi.fn() },
      false,
    );

    resolveOpen({
      chunks: chunksOf([{ type: 'text-delta', delta: 'once' }]),
      finalResult: Promise.resolve('once'),
    });

    const [, joiner] = await Promise.all([triggerPromise, joinerPromise]);

    expect(await drain(joiner.chunks)).toEqual([{ type: 'text-delta', delta: 'once' }]);
  });

  it('a stream failure rejects the in-flight entry too, so a subsequent call triggers a fresh stream', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());
    const failure = new Error('stream open failed');
    const openStream = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        chunks: chunksOf([{ type: 'text-delta', delta: 'recovered' }]),
        finalResult: Promise.resolve('recovered'),
      });

    await expect(
      orchestrator.runCachedStream({ cacheKey: 'k', ttl: 60, openStream }, false),
    ).rejects.toThrow('stream open failed');

    const { finalResult } = await orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream },
      false,
    );

    await expect(finalResult).resolves.toBe('recovered');
    expect(openStream).toHaveBeenCalledTimes(2);
  });

  it('does not cache the result when the stream itself fails after opening successfully', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());
    const failure = new Error('mid-stream failure');
    const openStream = vi.fn(async () => ({
      chunks: chunksOf([]),
      finalResult: Promise.reject(failure),
    }));

    const { finalResult } = await orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream },
      false,
    );

    await expect(finalResult).rejects.toThrow('mid-stream failure');
    expect(await cache.get('k')).toEqual({ hit: false, value: null });
  });

  it('hit: returns a one-shot replay built from the cached value without ever calling openStream', async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set('k', 'cached', 60);
    const orchestrator = new CacheOrchestrator(cache, silentLogger());
    const openStream = vi.fn();

    const { chunks, finalResult } = await orchestrator.runCachedStream(
      { cacheKey: 'k', ttl: 60, openStream },
      false,
    );

    expect(await drain(chunks)).toEqual([{ type: 'text-delta', delta: 'cached' }]);
    await expect(finalResult).resolves.toBe('cached');
    expect(openStream).not.toHaveBeenCalled();
  });
});

describe('CacheOrchestrator.resolveCacheKey / deleteCache', () => {
  it('returns the key unchanged when the adapter has no resolveKey', async () => {
    const cache = new InMemoryCacheAdapter();
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    expect(await orchestrator.resolveCacheKey('some key')).toBe('some key');
  });

  it('delegates to the adapter resolveKey when present', async () => {
    const cache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: vi.fn(),
      resolveKey: vi.fn(async (key: string) => key.toLowerCase()),
    };
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    expect(await orchestrator.resolveCacheKey('HELLO')).toBe('hello');
  });

  it('is a no-op when the adapter has no delete', async () => {
    const cache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: vi.fn(),
    };
    const orchestrator = new CacheOrchestrator(cache, silentLogger());

    await expect(orchestrator.deleteCache('k')).resolves.toBeUndefined();
  });

  it('logs a warning instead of throwing when the adapter delete fails', async () => {
    const logger = silentLogger();
    const cache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: vi.fn(),
      delete: vi.fn(async () => {
        throw new Error('delete failed');
      }),
    };
    const orchestrator = new CacheOrchestrator(cache, logger);

    await expect(orchestrator.deleteCache('k')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
