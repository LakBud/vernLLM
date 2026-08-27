import { describe, expect, it, vi } from 'vitest';

import {
  createMiddleware,
  createStateKey,
  VernLLM,
  type VernLLMEvent,
  type VernLLMMiddleware,
} from '../../src/index.js';
import { createMockClient, textResponse } from '../helpers.js';

describe('middleware smoke test', () => {
  it('transform patches the outgoing request, wrap sees the result and can add tracing', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);

    const events: string[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'redact-and-trace',
      transform: () => {
        return { addMessages: [{ role: 'user', content: 'appended by middleware' }] };
      },
      wrap: async (_request, next) => {
        events.push('wrap:before');
        const result = await next();
        events.push('wrap:after');
        return result;
      },
      onEvent: (event) => {
        events.push(`event:${event.kind}`);
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    const result = await llm.call({ userContent: 'hello', jsonMode: false });

    expect(result).toBe('hi');
    expect(events).toEqual(['wrap:before', 'event:middleware', 'wrap:after']);

    const sentMessages = calls[0]!.messages;
    expect(sentMessages.at(-1)).toEqual({ role: 'user', content: 'appended by middleware' });
  });

  it('a wrap that never calls next() short-circuits the real call', async () => {
    const { client, calls } = createMockClient([textResponse('should never be reached')]);

    const middleware: VernLLMMiddleware = {
      name: 'short-circuit',
      wrap: async () => ({ value: 'canned answer' }),
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    const result = await llm.call({ userContent: 'hello', jsonMode: false });

    expect(result).toBe('canned answer');
    expect(calls.length).toBe(0);
  });

  it('addTools from two middleware compose without clobbering each other', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);

    const mwA: VernLLMMiddleware = {
      name: 'a',
      priority: 0,
      transform: () => ({
        addTools: [
          { type: 'function', function: { name: 'toolA', description: 'a', parameters: {} } },
        ],
      }),
    };

    const mwB: VernLLMMiddleware = {
      name: 'b',
      priority: 1,
      transform: () => ({
        addTools: [
          { type: 'function', function: { name: 'toolB', description: 'b', parameters: {} } },
        ],
      }),
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [mwA, mwB],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    const sentTools = calls[0]!.tools;
    expect(sentTools?.map((t) => t.function.name)).toEqual(['toolA', 'toolB']);
  });

  it('a transform that tries to change model or response_format is rejected', async () => {
    const { client } = createMockClient([textResponse('hi')]);

    const middleware: VernLLMMiddleware = {
      name: 'bad',
      transform: () => {
        // Bypass the type system the way a plain-JS caller could.
        return { model: 'sneaky-model' } as never;
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    await expect(llm.call({ userContent: 'hello', jsonMode: false })).rejects.toThrow(
      /changed `model`/,
    );
  });

  it('enabled: false skips the middleware entirely', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);

    const middleware: VernLLMMiddleware = {
      name: 'disabled',
      enabled: false,
      transform: () => ({ addMessages: [{ role: 'user', content: 'should not appear' }] }),
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    const sentMessages = calls[0]!.messages;
    expect(sentMessages.some((m) => m.role === 'user' && m.content === 'should not appear')).toBe(
      false,
    );
  });

  it('a wrap throwing after next() resolved keeps the original result', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const middleware: VernLLMMiddleware = {
      name: 'post-fail',
      wrap: async (_request, next) => {
        await next();
        throw new Error('post-processing bug');
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
      logger,
    });

    const result = await llm.call({ userContent: 'hello', jsonMode: false });

    expect(result).toBe('hi');
    expect(logger.error).toHaveBeenCalled();
  });

  it('cachedCall: wrap fires exactly once on a cache miss, not once for cachedCall and once for the inner call()', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    let wrapCount = 0;

    const middleware: VernLLMMiddleware = {
      name: 'counter',
      wrap: async (_request, next) => {
        wrapCount++;
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    const result = await llm.cachedCall({
      cacheKey: 'k1',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });

    expect(result).toBe('hi');
    expect(wrapCount).toBe(1);
  });

  it('cachedCall: two concurrent invocations sharing the same explicit requestId each still run their own outer wrap', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const wrapEvents: string[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'counter',
      wrap: async (request, next) => {
        wrapEvents.push('start');
        const result = await next();
        wrapEvents.push('end');
        return result;
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    // Same explicit requestId, different cache keys so both are genuine
    // misses (each triggers its own inner call()), run concurrently. The
    // old requestId-keyed `Set<string>` suppression mechanism could let
    // one invocation's inner-call marker suppress the *other* still
    // in-flight invocation's own outer `wrap`, since both used the same
    // key; the object-identity-keyed marker can't cross invocations.
    const [first, second] = await Promise.all([
      llm.cachedCall({
        cacheKey: 'k-dup-a',
        ttl: 60_000,
        call: { userContent: 'hello', jsonMode: false, requestId: 'dup-id' },
      }),
      llm.cachedCall({
        cacheKey: 'k-dup-b',
        ttl: 60_000,
        call: { userContent: 'hello', jsonMode: false, requestId: 'dup-id' },
      }),
    ]);

    expect([first, second].sort()).toEqual(['first', 'second']);
    // Each cachedCall() wraps its own outer operation once: two `start`s,
    // two `end`s. A suppressed outer wrap would show up as fewer than 4
    // events total, or a `start` with no matching `end` for one call.
    expect(wrapEvents.filter((e) => e === 'start')).toHaveLength(2);
    expect(wrapEvents.filter((e) => e === 'end')).toHaveLength(2);
  });

  it('call: two concurrent invocations sharing the same explicit requestId each still run their own wrap', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    let wrapCount = 0;

    const middleware: VernLLMMiddleware = {
      name: 'counter',
      wrap: async (_request, next) => {
        wrapCount++;
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    const [first, second] = await Promise.all([
      llm.call({ userContent: 'hello', jsonMode: false, requestId: 'dup-id-2' }),
      llm.call({ userContent: 'hello', jsonMode: false, requestId: 'dup-id-2' }),
    ]);

    expect([first, second].sort()).toEqual(['first', 'second']);
    expect(wrapCount).toBe(2);
  });

  it('cachedCall: wrap fires exactly once on a cache hit too, with next() resolving to the cached value', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);
    const wrapCalls: unknown[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'counter',
      wrap: async (_request, next) => {
        const result = await next();
        wrapCalls.push(result.value);
        return result;
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    // Miss, populates the cache.
    await llm.cachedCall({
      cacheKey: 'k2',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });

    // Hit: no second provider call, wrap still fires exactly once more.
    const result = await llm.cachedCall({
      cacheKey: 'k2',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });

    expect(result).toBe('hi');
    expect(calls.length).toBe(1);
    expect(wrapCalls).toEqual(['hi', 'hi']);
  });

  it('cachedCall: wrap sees populated meta on a miss, and undefined meta on a hit', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const metas: unknown[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'meta-observer',
      wrap: async (_request, next) => {
        const result = await next();
        metas.push(result.meta);
        return result;
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      name: 'primary',
      middleware: [middleware],
    });

    await llm.cachedCall({
      cacheKey: 'k3',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });

    await llm.cachedCall({
      cacheKey: 'k3',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });

    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatchObject({ provider: 'primary', usedFallback: false, attempts: 1 });
    expect(metas[1]).toBeUndefined();
  });

  it('cachedCall: a value set by wrap in ctx.state is visible to transform on the same cache miss', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const spanId = createStateKey<string>('span-id');
    let seenInTransform: string | undefined;

    const middleware: VernLLMMiddleware = {
      name: 'span',
      wrap: async (_request, next, ctx) => {
        ctx.state.set(spanId, 'abc123');
        return next();
      },
      transform: (_request, ctx) => {
        seenInTransform = ctx.state.get(spanId);
        return {};
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    await llm.cachedCall({
      cacheKey: 'k-state-share',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });

    expect(seenInTransform).toBe('abc123');
  });

  it('cachedCall: a metaHolder entry does not leak when wrap short-circuits without calling next()', async () => {
    const { client } = createMockClient([textResponse('real answer')]);

    const shortCircuit: VernLLMMiddleware = {
      name: 'short-circuit',
      wrap: async () => ({ value: 'canned' }),
    };

    const llm1 = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [shortCircuit],
    });

    // Trigger: this call's wrap never calls next(), so coreOperation, and
    // any cleanup nested only inside it, never runs at all. Without the
    // outer try/finally, the metaHolder entry for this cacheKey would
    // stay in cachedCallMeta forever.
    const first = await llm1.cachedCall({
      cacheKey: 'k-short-circuit-leak',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });
    expect(first).toBe('canned');

    // A later cachedCall() for the same cacheKey, on a fresh instance
    // with no short-circuiting middleware, should see a real cache miss
    // and real meta, not a stale, permanently-empty holder reused from
    // the first call's leaked entry.
    const metas: unknown[] = [];
    const observer: VernLLMMiddleware = {
      name: 'observer',
      wrap: async (_request, next) => {
        const result = await next();
        metas.push(result.meta);
        return result;
      },
    };

    const llm2 = new VernLLM({ client, model: 'gpt-4o', middleware: [observer] });

    const second = await llm2.cachedCall({
      cacheKey: 'k-short-circuit-leak',
      ttl: 60_000,
      call: { userContent: 'hello', jsonMode: false },
    });

    expect(second).toBe('real answer');
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ provider: 'primary' });
  });

  it('createMiddleware: onError observes a failure without changing it, and never fires on success', async () => {
    const { client } = createMockClient([new Error('boom'), textResponse('recovered')]);

    const onError = vi.fn();
    const middleware = createMiddleware({ name: 'observer', onError });

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      maxRetries: 1,
      middleware: [middleware],
    });

    const result = await llm.call({ userContent: 'hello', jsonMode: false });

    // The call itself succeeded (after a retry), so onError never fires
    // even though the underlying client rejected once.
    expect(result).toBe('recovered');
    expect(onError).not.toHaveBeenCalled();
  });

  it('createMiddleware: onError fires with the terminal error and the original error still propagates', async () => {
    const { client } = createMockClient([new Error('permanent failure')]);

    const onError = vi.fn();
    const middleware = createMiddleware({ name: 'observer', onError });

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      maxRetries: 0,
      middleware: [middleware],
    });

    await expect(llm.call({ userContent: 'hello', jsonMode: false })).rejects.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    const observed = onError.mock.calls[0]![0];
    expect(observed.cause).toMatchObject({ message: 'permanent failure' });
  });

  it('composition order: lower priority is outermost, first to start pre-next(), last to finish post-next()', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const events: string[] = [];

    const outer: VernLLMMiddleware = {
      name: 'outer',
      priority: 0,
      wrap: async (_request, next) => {
        events.push('outer:pre');
        const result = await next();
        events.push('outer:post');
        return result;
      },
    };

    const inner: VernLLMMiddleware = {
      name: 'inner',
      priority: 1,
      wrap: async (_request, next) => {
        events.push('inner:pre');
        const result = await next();
        events.push('inner:post');
        return result;
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [outer, inner],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(events).toEqual(['outer:pre', 'inner:pre', 'inner:post', 'outer:post']);
  });

  it('ctx.state round-trips a value through the same MiddlewareStateKey reference, shared across middleware', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const spanIdKey = createStateKey<string>('tracing.spanId');
    let observed: string | undefined;

    const setter: VernLLMMiddleware = {
      name: 'setter',
      priority: 0,
      wrap: async (_request, next, ctx) => {
        ctx.state.set(spanIdKey, 'span-123');
        return next();
      },
    };

    const reader: VernLLMMiddleware = {
      name: 'reader',
      priority: 1,
      wrap: async (_request, next, ctx) => {
        observed = ctx.state.get(spanIdKey);
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [setter, reader],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(observed).toBe('span-123');
  });

  it('two independently created state keys with the same debugName never collide', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const keyA = createStateKey<string>('shared-name');
    const keyB = createStateKey<string>('shared-name');
    let observedViaB: string | undefined;

    const middleware: VernLLMMiddleware = {
      name: 'mw',
      wrap: async (_request, next, ctx) => {
        ctx.state.set(keyA, 'value-for-a');
        observedViaB = ctx.state.get(keyB);
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(observedViaB).toBeUndefined();
  });

  it('ctx.own never collides between two middleware that pick the same key', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const observedOwn: unknown[] = [];

    const mwA: VernLLMMiddleware = {
      name: 'a',
      priority: 0,
      wrap: async (_request, next, ctx) => {
        ctx.own.value = 'from-a';
        return next();
      },
    };

    const mwB: VernLLMMiddleware = {
      name: 'b',
      priority: 1,
      wrap: async (_request, next, ctx) => {
        observedOwn.push(ctx.own.value);
        ctx.own.value = 'from-b';
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [mwA, mwB],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    // mwB's own.value was never set by mwA, since each middleware gets
    // its own ctx.own, pre-namespaced to that middleware.
    expect(observedOwn).toEqual([undefined]);
  });

  it('wrap itself is never bounded by middlewareTimeoutMs, only transform/enabled are', async () => {
    const { client } = createMockClient([textResponse('hi')]);

    const middleware: VernLLMMiddleware = {
      name: 'slow-wrap',
      wrap: async (_request, next) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [middleware],
      middlewareTimeoutMs: 10,
    });

    // Would reject with a timeout error if wrap were bounded by
    // middlewareTimeoutMs the same way transform/enabled are.
    const result = await llm.call({ userContent: 'hello', jsonMode: false });
    expect(result).toBe('hi');
  });

  it("the 'middleware' transform event fires only when a patch actually changed something, staying silent on a no-op transform", async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const events: Array<Extract<VernLLMEvent, { kind: 'middleware' }>> = [];

    const noOpMiddleware: VernLLMMiddleware = {
      name: 'no-op',
      priority: 0,
      transform: () => ({}),
    };

    const realPatchMiddleware: VernLLMMiddleware = {
      name: 'real-patch',
      priority: 1,
      transform: () => ({ addMessages: [{ role: 'user', content: 'tagged' }] }),
    };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [noOpMiddleware, realPatchMiddleware],
      onEvent: (event: VernLLMEvent) => {
        if (event.kind === 'middleware') events.push(event);
      },
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'middleware',
      middleware: 'real-patch',
      hook: 'transform',
      patchedFields: ['addMessages'],
    });
  });
});
