import { describe, expect, it, vi } from 'vitest';

import {
  createStateKey,
  stateEntry,
  type CallMeta,
  type VernLLMEvent,
  type VernLLMMiddleware,
} from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  FakeApiError,
  textResponse,
} from '../../helpers.js';
import { CALL, heldResponse, streamClient, wrapCounter } from './middleware.int.helpers.js';

import type { RefundUsage, ReserveUsage } from '../../../src/types/usage.js';

describe('CallResult.cache', () => {
  const observe = () => {
    const seen: Array<'hit' | 'join' | undefined> = [];
    const middleware: VernLLMMiddleware = {
      name: 'observe-cache',
      wrap: async (_request, next) => {
        const result = await next();
        seen.push(result.cache);
        return result;
      },
    };
    return { seen, middleware };
  };

  it('is unset on a miss and `hit` on a stored value', async () => {
    const { client } = createMockClient([textResponse('a')]);
    const { seen, middleware } = observe();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });
    const params = { cacheKey: 'k', ttl: 1000, call: CALL };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    expect(seen).toEqual([undefined, 'hit']);
  });

  it('is `join` for a caller that shares an in flight call', async () => {
    let resolveCall!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveCall = resolve;
    });
    const { client } = createMockClient([() => pending as Promise<never>]);
    const { seen, middleware } = observe();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });
    const params = { cacheKey: 'k', ttl: 1000, call: CALL };

    const both = Promise.all([llm.cachedCall(params), llm.cachedCall(params)]);
    resolveCall(textResponse('a'));
    await both;

    expect(seen.sort()).toEqual(['join', undefined]);
  });

  it('is `join` for a streamed caller, which returns before the shared call answers', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'x' }]]);
    const { seen, middleware } = observe();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });
    const params = { cacheKey: 'k', ttl: 1000, call: { ...CALL, stream: true as const } };

    const [first, second] = await Promise.all([llm.cachedCall(params), llm.cachedCall(params)]);
    await Promise.all([first.finalResult, second.finalResult]);

    expect(seen.sort()).toEqual(['join', undefined]);
  });

  it('is `hit` for a streamed stored value', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'x' }]]);
    const { seen, middleware } = observe();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });
    const params = { cacheKey: 'k', ttl: 1000, call: { ...CALL, stream: true as const } };

    await (
      await llm.cachedCall(params)
    ).finalResult;
    await (
      await llm.cachedCall(params)
    ).finalResult;

    expect(seen).toEqual([undefined, 'hit']);
  });
});

describe('middleware with cachedCall', () => {
  it('a real miss then hit: transform runs on the miss only, and wrap runs once per cachedCall()', async () => {
    const { client, calls } = createMockClient([textResponse('computed')]);
    const wrapEvents: string[] = [];
    let transformRuns = 0;

    const middleware: VernLLMMiddleware = {
      name: 'cache-aware',
      transform: () => {
        transformRuns++;
        return { addMessages: [{ role: 'user', content: 'tagged' }] };
      },
      wrap: async (_request, next) => {
        wrapEvents.push('wrap:start');
        const result = await next();
        wrapEvents.push(`wrap:end:${result.value}`);
        return result;
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });
    const callParams = { cacheKey: 'ck', ttl: 1000, call: CALL };

    await expect(llm.cachedCall(callParams)).resolves.toBe('computed');
    await expect(llm.cachedCall(callParams)).resolves.toBe('computed');

    expect(calls).toHaveLength(1);
    expect(transformRuns).toBe(1);
    expect(wrapEvents).toEqual([
      'wrap:start',
      'wrap:end:computed',
      'wrap:start',
      'wrap:end:computed',
    ]);
    expect(calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'tagged' });
  });

  it('a real streaming miss then hit: wrap runs once per cachedCall()', async () => {
    const { client, calls } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'streamed' }],
    ]);
    const counter = wrapCounter();

    const llm = new VernLLM({ client, model: 'test-model', middleware: [counter.middleware] });
    const callParams = { cacheKey: 'sk', ttl: 1000, call: { ...CALL, stream: true as const } };

    const first = await llm.cachedCall(callParams);
    const second = await llm.cachedCall(callParams);

    await expect(first.finalResult).resolves.toBe('streamed');
    await expect(second.finalResult).resolves.toBe('streamed');
    expect(calls).toHaveLength(1);
    expect(counter.count()).toBe(2);
  });

  it('two concurrent callers on one cacheKey join a single in flight miss, each with its own wrap', async () => {
    let resolveCall!: (value: unknown) => void;
    const pendingCall = new Promise((resolve) => {
      resolveCall = resolve;
    });
    const { client, create } = createMockClient([() => pendingCall as Promise<never>]);
    const counter = wrapCounter();

    const llm = new VernLLM({ client, model: 'test-model', middleware: [counter.middleware] });
    const callParams = { cacheKey: 'join-key', ttl: 1000, call: CALL };

    // Both start before either resolves, so the second joins the first's in flight miss.
    const first = llm.cachedCall(callParams);
    const second = llm.cachedCall(callParams);
    resolveCall(textResponse('joined result'));

    await expect(Promise.all([first, second])).resolves.toEqual(['joined result', 'joined result']);

    expect(create).toHaveBeenCalledTimes(1);
    // One wrap for each caller's own cachedCall(), and none for the request they shared.
    expect(counter.count()).toBe(2);
  });

  it('dispatch runs on the miss only, never on the hit', async () => {
    const { client, create } = createMockClient([textResponse('cached answer')]);
    const dispatch = vi.fn(async (_request: unknown, next: () => Promise<void>) => next());

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [{ name: 'observer', dispatch }],
    });
    const callParams = { cacheKey: 'ck', ttl: 1000, call: CALL };

    await expect(llm.cachedCall(callParams)).resolves.toBe('cached answer');
    await expect(llm.cachedCall(callParams)).resolves.toBe('cached answer');

    expect(create).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('ctx.emit works from wrap on a miss and a hit, and from transform on the miss only', async () => {
    const { client } = createMockClient([textResponse('computed')]);
    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: 'silent',
      onEvent: (event) => void events.push(event),
      middleware: [
        {
          name: 'cache-emitter',
          wrap: async (_request, next, ctx) => {
            ctx.emit('hook', { hook: 'wrap' });
            return next();
          },
          transform: (_request, ctx) => {
            ctx.emit('hook', { hook: 'transform' });
            return {};
          },
        },
      ],
    });
    const callParams = { cacheKey: 'ck', ttl: 1000, call: { ...CALL, requestId: 'req-cached' } };

    await llm.cachedCall(callParams);
    await llm.cachedCall(callParams);

    const custom = events.filter((event) => event.kind === 'custom');
    // The miss runs wrap then transform, the hit runs wrap alone.
    expect(custom.map((event) => event.data)).toEqual([
      { hook: 'wrap' },
      { hook: 'transform' },
      { hook: 'wrap' },
    ]);
    expect(new Set(custom.map((event) => event.requestId))).toEqual(new Set(['req-cached']));
  });
});

describe('cachedCall seeded state', () => {
  const key = createStateKey<string>('test.caller');

  it("gives each caller's wrap its own state on a miss, a join and a hit; the shared request sees the leader's", async () => {
    let resolveCall!: (value: unknown) => void;
    const pendingCall = new Promise((resolve) => {
      resolveCall = resolve;
    });
    const { client, create } = createMockClient([() => pendingCall as Promise<never>]);
    const wrapSeen: Record<string, unknown> = {};
    const transformSeen: unknown[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: 'silent',
      middleware: [
        {
          name: 'reader',
          wrap: async (_request, next, ctx) => (
            (wrapSeen[ctx.requestId] = ctx.state.get(key)),
            next()
          ),
          transform: (_request, ctx) => (transformSeen.push(ctx.state.get(key)), {}),
        },
      ],
    });
    const call = (requestId: string, caller: string) =>
      llm.cachedCall({
        cacheKey: 'shared',
        ttl: 1000,
        call: { ...CALL, requestId, state: [stateEntry(key, caller)] },
      });

    // Concurrent: the first is the miss that runs the request, the second joins it.
    const leader = call('leader', 'A');
    const follower = call('follower', 'B');
    resolveCall(textResponse('shared result'));
    await Promise.all([leader, follower]);
    // Later: a plain hit.
    await call('hit', 'C');

    expect(create).toHaveBeenCalledTimes(1);
    expect(wrapSeen).toEqual({ leader: 'A', follower: 'B', hit: 'C' });
    // The shared request ran once, for the leader, and the follower's state was never used for it.
    expect(transformSeen).toEqual(['A']);
  });

  it('does not change the cache key, so different state still hits the same entry', async () => {
    const { client, create } = createMockClient([textResponse('computed')]);
    const llm = new VernLLM({ client, model: 'test-model', logger: 'silent' });
    const call = (caller: string) =>
      llm.cachedCall({
        cacheKey: 'ck',
        ttl: 1000,
        call: { ...CALL, state: [stateEntry(key, caller)] },
      });

    await expect(call('A')).resolves.toBe('computed');
    await expect(call('B')).resolves.toBe('computed');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid state without leaving the cache key claimed, so the next call still runs', async () => {
    const { client, create } = createMockClient([textResponse('computed')]);
    const llm = new VernLLM({ client, model: 'test-model', logger: 'silent' });
    const params = (state: unknown) => ({
      cacheKey: 'ck',
      ttl: 1000,
      call: { ...CALL, state: state as never },
    });

    await expect(llm.cachedCall(params('nope'))).rejects.toMatchObject({
      type: 'invalid_params',
    });
    await expect(llm.cachedCall(params([stateEntry(key, 'A')]))).resolves.toBe('computed');

    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('next.again() with cachedCall', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const rerunCall = { ...CALL, context: { rerun: true } };

  /** Starts the main chain, waits for it to reach the provider, then keeps a rerun's result. */
  const rerunAfterMain: VernLLMMiddleware = {
    name: 'rerun-after-main',
    reruns: true,
    wrap: async (_request, next, ctx) => {
      if (!next.again || ctx.context?.rerun !== true) return next();

      next().catch(() => {});
      await sleep(10);

      return next.again();
    },
  };

  it('still caches and hits when the wrap only calls next()', async () => {
    const { client, create } = createMockClient([textResponse('a')]);
    const seen: Array<'hit' | 'join' | undefined> = [];
    const middleware: VernLLMMiddleware = {
      name: 'plain',
      reruns: true,
      wrap: async (_request, next) => {
        const result = await next();
        seen.push(result.cache);
        return result;
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });
    const params = { cacheKey: 'k', ttl: 1000, call: CALL };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    expect(seen).toEqual([undefined, 'hit']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('makes a provider call for a rerun after a hit, and replaces the cached answer', async () => {
    const { client, create } = createMockClient([textResponse('old'), textResponse('new')]);
    const again: VernLLMMiddleware = {
      name: 'again',
      reruns: true,
      wrap: async (_request, next, ctx) => {
        const first = await next();

        return ctx.context?.rerun === true && first.cache === 'hit' && next.again
          ? next.again()
          : first;
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [again] });
    const key = { cacheKey: 'k', ttl: 1000 };

    await expect(llm.cachedCall({ ...key, call: CALL })).resolves.toBe('old');
    await expect(llm.cachedCall({ ...key, call: rerunCall })).resolves.toBe('new');
    await expect(llm.cachedCall({ ...key, call: CALL })).resolves.toBe('new');

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('gives the caller a kept rerun on a miss, cancels the shared call, caches it, and drops cache from the result', async () => {
    const held = heldResponse('slow');
    const { client, create } = createMockClient([held.entry, textResponse('fast')]);
    let seenCache: unknown = 'unset';
    const observer: VernLLMMiddleware = {
      name: 'observer',
      priority: 0,
      wrap: async (_request, next) => {
        const result = await next();
        seenCache = result.cache;
        return result;
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [observer, { ...rerunAfterMain, priority: 1 }],
    });
    const meta: { current?: CallMeta } = {};
    const key = { cacheKey: 'k', ttl: 1000 };

    await expect(llm.cachedCall({ ...key, call: { ...rerunCall, meta } })).resolves.toBe('fast');

    expect(seenCache).toBeUndefined();
    expect(meta.current).toMatchObject({ chain: 1 });
    await vi.waitFor(() => expect(held.aborted()).toBe(true));

    await expect(llm.cachedCall({ ...key, call: CALL })).resolves.toBe('fast');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('leaves the shared call running for a second caller who joined, who gets its answer', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([held.entry, textResponse('fast')]);
    const llm = new VernLLM({ client, model: 'test-model', middleware: [rerunAfterMain] });
    const key = { cacheKey: 'k', ttl: 1000 };

    const first = llm.cachedCall({ ...key, call: rerunCall });
    await sleep(5);
    const joiner = llm.cachedCall({ ...key, call: CALL });

    await expect(first).resolves.toBe('fast');
    expect(held.aborted()).toBe(false);

    held.release();

    await expect(joiner).resolves.toBe('slow');
  });

  it('reserves a rerun as a full spend and refunds it when it is cancelled', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([textResponse('first'), held.entry]);
    const reserveUsage = vi.fn<ReserveUsage>(async () => {});
    const refundUsage = vi.fn<RefundUsage>(async () => {});
    const keepMain: VernLLMMiddleware = {
      name: 'keep-main',
      reruns: true,
      wrap: async (_request, next) => {
        const first = await next();

        next.again!().catch(() => {});
        await sleep(10);

        return first;
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [keepMain] });

    await llm.cachedCall({ cacheKey: 'k', ttl: 1000, call: CALL, reserveUsage, refundUsage });
    await vi.waitFor(() => expect(refundUsage).toHaveBeenCalledTimes(1));

    expect(reserveUsage.mock.calls.map(([arg]) => arg.coalesced)).toEqual([false, false]);
    expect(refundUsage.mock.calls[0]![0]).toMatchObject({ coalesced: false });
  });

  /** Keeps the main chain and lets a rerun that fails go, so the rerun's reservation is refunded. */
  const keepMainAfterFailedRerun: VernLLMMiddleware = {
    name: 'keep-main-after-failed-rerun',
    reruns: true,
    wrap: async (_request, next) => {
      const first = await next();
      await next.again!().catch(() => {});

      return first;
    },
  };

  it('logs a failed refund of a rerun and still returns the main answer', async () => {
    const { client } = createMockClient([textResponse('first'), new FakeApiError('down', 500)]);
    const reserveUsage = vi.fn<ReserveUsage>(async () => {});
    const refundUsage = vi.fn<RefundUsage>(async () => {
      throw new Error('refund store down');
    });
    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      logger: 'silent',
      middleware: [keepMainAfterFailedRerun],
    });

    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 1000, call: CALL, reserveUsage, refundUsage }),
    ).resolves.toBe('first');

    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('logs a failed refund of a streamed rerun and still returns the main answer', async () => {
    const { client } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'first' }],
      new FakeApiError('down', 500),
    ]);
    const reserveUsage = vi.fn<ReserveUsage>(async () => {});
    const refundUsage = vi.fn<RefundUsage>(async () => {
      throw new Error('refund store down');
    });
    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      logger: 'silent',
      middleware: [keepMainAfterFailedRerun],
    });

    const { finalResult } = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 1000,
      call: { ...CALL, stream: true },
      reserveUsage,
      refundUsage,
    });

    await expect(finalResult).resolves.toBe('first');
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it("keeps the main chain's meta when the wrap returns a result that merely carries a chain", async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const meta: { current?: CallMeta } = {};
    const rebuild: VernLLMMiddleware = {
      name: 'rebuild',
      reruns: true,
      wrap: async (_request, next) => {
        const first = await next();
        await next.again!();

        return { ...first, meta: first.meta && { ...first.meta, chain: 1 } };
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [rebuild] });

    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 1000, call: { ...CALL, meta } }),
    ).resolves.toBe('first');

    expect(meta.current).toMatchObject({ attempts: 1 });
    expect(meta.current?.chain).toBeUndefined();
  });

  it('relays a streamed rerun, caches it on finalResult, and keeps its meta and chain', async () => {
    const never = new Promise<void>(() => {});
    const { client, signals } = streamClient([{ text: 'slow', gate: never }, { text: 'fast' }]);
    const llm = new VernLLM({ client, model: 'test-model', middleware: [rerunAfterMain] });
    const meta: { current?: CallMeta } = {};
    const key = { cacheKey: 'k', ttl: 1000 };

    const { finalResult } = await llm.cachedCall({
      ...key,
      call: { ...rerunCall, stream: true, meta },
    });

    await expect(finalResult).resolves.toBe('fast');
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));

    expect(meta.current).toMatchObject({ chain: 1 });

    const replay = await llm.cachedCall({ ...key, call: { ...CALL, stream: true } });

    await expect(replay.finalResult).resolves.toBe('fast');
    expect(signals).toHaveLength(2);
  });

  it('cancels a streamed rerun when the caller leaves chunks early', async () => {
    const { client, signals } = streamClient([
      { text: 'a', hold: true },
      { text: 'b', hold: true },
    ]);
    const llm = new VernLLM({ client, model: 'test-model', middleware: [rerunAfterMain] });

    const { chunks } = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 1000,
      call: { ...rerunCall, stream: true },
    });

    for await (const _chunk of chunks) break;

    await vi.waitFor(() => {
      expect(signals).toHaveLength(2);
      expect(signals[1]!.aborted).toBe(true);
    });
  });
});
