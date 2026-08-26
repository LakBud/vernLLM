import { describe, expect, it, vi } from 'vitest';

import { LLMError } from '../../src/types/errors.js';
import { FallbackExhaustedError } from '../../src/types/fallback.js';
import { createStateKey, type VernLLMMiddleware } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  FakeApiError,
  textResponse,
} from '../helpers.js';

describe('middleware workflow integration', () => {
  it('transform reaches the real streaming adapter path and wrap observes the streamed result', async () => {
    const { client, calls } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'hello' },
        { type: 'text-delta', delta: ' world' },
      ],
    ]);

    const events: string[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'stream-mw',
      transform: () => ({ addMessages: [{ role: 'user', content: 'appended' }] }),
      wrap: async (_request, next) => {
        events.push('wrap:before');
        const result = await next();
        events.push('wrap:after');
        return result;
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    const value = await finalResult;

    expect(value).toBe('hello world');
    // wrap:after only fires once the stream *opened*, matching
    // `runFallbackChain`'s documented contract (mid-stream content is
    // observed separately, through finalResult).
    expect(events).toEqual(['wrap:before', 'wrap:after']);
    expect(calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'appended' });
  });

  it('wrap fires exactly once across a real fallback chain: primary fails, fallback answers', async () => {
    const { client: primaryClient } = createMockClient([new FakeApiError('primary down', 500)]);
    const { client: fallbackClient } = createMockClient([textResponse('from fallback')]);

    let wrapCount = 0;
    const seenProviders: string[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'counter',
      wrap: async (_request, next, ctx) => {
        wrapCount++;
        seenProviders.push(ctx.requestedProvider);
        return next();
      },
    };

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      maxRetries: 0,
      middleware: [middleware],
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
      },
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('from fallback');
    expect(wrapCount).toBe(1);
    // ctx.requestedProvider describes the primary target only, per
    // MiddlewareContext's documented caveat; the real target that
    // answered is only visible through next()'s resolved meta.
    expect(seenProviders).toEqual(['primary']);
  });

  it("wrap's next() resolves with meta describing the fallback target that actually answered", async () => {
    const { client: primaryClient } = createMockClient([new FakeApiError('primary down', 500)]);
    const { client: fallbackClient } = createMockClient([textResponse('from fallback')]);

    let observedMeta: unknown;

    const middleware: VernLLMMiddleware = {
      name: 'meta-observer',
      wrap: async (_request, next) => {
        const result = await next();
        observedMeta = result.meta;
        return result;
      },
    };

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      maxRetries: 0,
      middleware: [middleware],
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
      },
    });

    await llm.call({ userContent: 'hi', jsonMode: false });

    expect(observedMeta).toMatchObject({
      provider: 'fallback',
      usedFallback: true,
      fallbackIndex: 0,
    });
  });

  it('wrap still fires exactly once when a single-target circuit breaker rejects the call before any attempt is made', async () => {
    const { client } = createMockClient([new FakeApiError('down', 500)]);
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
      model: 'test-model',
      maxRetries: 0,
      middleware: [middleware],
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    // First call trips the breaker.
    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toThrow();
    expect(wrapCount).toBe(1);

    // Second call is rejected by the open breaker itself, before any
    // attempt is made, still wrapped exactly once.
    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toThrow();
    expect(wrapCount).toBe(2);
  });

  it('two middleware compose transform + wrap together against a real retry that eventually succeeds', async () => {
    const { client, calls } = createMockClient([
      new FakeApiError('temporary', 500),
      textResponse('recovered'),
    ]);

    const trace: string[] = [];
    const spanKey = createStateKey<string>('span');

    const tracing: VernLLMMiddleware = {
      name: 'tracing',
      priority: 0,
      transform: (request, ctx) => {
        trace.push(`transform:attempt-${ctx.attempt}`);
        return {};
      },
      wrap: async (_request, next, ctx) => {
        ctx.state.set(spanKey, 'span-abc');
        trace.push('wrap:start');
        const result = await next();
        trace.push('wrap:end');
        return result;
      },
    };

    const costTracking: VernLLMMiddleware = {
      name: 'cost-tracking',
      priority: 1,
      wrap: async (_request, next, ctx) => {
        // Written by `tracing`'s pre-next() phase, which (lower
        // priority, so outermost) always finishes before this
        // middleware's own pre-next() phase runs.
        expect(ctx.state.get(spanKey)).toBe('span-abc');
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      middleware: [tracing, costTracking],
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('recovered');
    expect(calls.length).toBe(2);
    // transform re-runs once per real attempt, wrap runs exactly once
    // for the whole logical call regardless of how many attempts ran
    // underneath it.
    expect(trace).toEqual(['wrap:start', 'transform:attempt-1', 'transform:attempt-2', 'wrap:end']);
  });

  it('cachedCall: a real cache miss then hit, with transform + wrap composing and wrap firing once per cachedCall()', async () => {
    const { client, calls } = createMockClient([textResponse('computed')]);

    const wrapEvents: string[] = [];
    const transformedRequests: number[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'cache-aware',
      transform: () => {
        transformedRequests.push(1);
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

    const callParams = { cacheKey: 'ck', ttl: 1000, call: { userContent: 'hi', jsonMode: false } };

    const first = await llm.cachedCall(callParams);
    const second = await llm.cachedCall(callParams);

    expect(first).toBe('computed');
    expect(second).toBe('computed');
    expect(calls.length).toBe(1);
    // transform only ever runs on the real miss, never on the hit.
    expect(transformedRequests).toEqual([1]);
    expect(wrapEvents).toEqual([
      'wrap:start',
      'wrap:end:computed',
      'wrap:start',
      'wrap:end:computed',
    ]);
    expect(calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'tagged' });
  });

  it('cachedCall: a real streaming cache miss then hit, wrap firing once per cachedCall()', async () => {
    const { client, calls } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'streamed' }],
    ]);

    let wrapCount = 0;

    const middleware: VernLLMMiddleware = {
      name: 'counter',
      wrap: async (_request, next) => {
        wrapCount++;
        return next();
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    const callParams = {
      cacheKey: 'sk',
      ttl: 1000,
      call: { userContent: 'hi', jsonMode: false, stream: true as const },
    };

    const first = await llm.cachedCall(callParams);
    const firstValue = await first.finalResult;

    const second = await llm.cachedCall(callParams);
    const secondValue = await second.finalResult;

    expect(firstValue).toBe('streamed');
    expect(secondValue).toBe('streamed');
    expect(calls.length).toBe(1);
    expect(wrapCount).toBe(2);
  });

  it('a middleware that rejects a bad request via transform (invalid_params) prevents the real network call from ever going out', async () => {
    const { client, create } = createMockClient([textResponse('should never be reached')]);

    const guard: VernLLMMiddleware = {
      name: 'guard',
      transform: (request) => {
        const hasSecret = request.messages.some(
          (m) => typeof m.content === 'string' && m.content.includes('SECRET'),
        );
        if (hasSecret) {
          throw new LLMError('blocked: message contains a secret', 'invalid_params');
        }
        return {};
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [guard] });

    await expect(
      llm.call({ userContent: 'here is a SECRET value', jsonMode: false }),
    ).rejects.toMatchObject({ type: 'invalid_params' });

    expect(create).not.toHaveBeenCalled();
  });

  it('a wrap middleware serving a canned answer for a known input fully bypasses fallback, never touching either target', async () => {
    const { client: primaryClient, create: primaryCreate } = createMockClient([
      textResponse('unused'),
    ]);
    const { client: fallbackClient, create: fallbackCreate } = createMockClient([
      textResponse('unused'),
    ]);

    const cache: VernLLMMiddleware = {
      name: 'canned-response',
      wrap: async (request) => {
        const lastMessage = request.messages.at(-1);
        if (lastMessage?.content === 'ping') {
          return { value: 'pong' };
        }
        throw new Error('unreachable in this test');
      },
    };

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      middleware: [cache],
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const result = await llm.call({ userContent: 'ping', jsonMode: false });

    expect(result).toBe('pong');
    expect(primaryCreate).not.toHaveBeenCalled();
    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it('a genuinely broken middleware throwing a plain bug fails fast without retrying and never counts toward the breaker', async () => {
    const { client, create } = createMockClient([textResponse('would have worked')]);

    const buggy: VernLLMMiddleware = {
      name: 'buggy',
      transform: () => {
        throw new Error('undefined is not a function');
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 3,
      baseDelayMs: 1,
      middleware: [buggy],
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'middleware_threw',
    });

    // Never retried: a deterministic bug fails identically on every
    // attempt, so it's excluded from retry.
    expect(create).not.toHaveBeenCalled();

    // A second call still fails the same way (unaffected by the
    // breaker, since invalid_params never counts toward it): the
    // deterministic bug means `transform` throws again before the real
    // client is ever reached, not that this call "reaches the client"
    // in any meaningful sense.
    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
      type: 'invalid_params',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('addTools duplicate check fires against a real request reaching the fallback target, naming the offending middleware', async () => {
    const { client: primaryClient } = createMockClient([new FakeApiError('down', 500)]);
    const { client: fallbackClient } = createMockClient([textResponse('unused')]);

    const mwA: VernLLMMiddleware = {
      name: 'tool-a',
      priority: 0,
      transform: () => ({
        addTools: [
          { type: 'function', function: { name: 'shared', description: 'a', parameters: {} } },
        ],
      }),
    };

    const mwB: VernLLMMiddleware = {
      name: 'tool-b',
      priority: 1,
      transform: () => ({
        addTools: [
          { type: 'function', function: { name: 'shared', description: 'b', parameters: {} } },
        ],
      }),
    };

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      middleware: [mwA, mwB],
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const outcome = await llm
      .call({ userContent: 'hi', jsonMode: false })
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(FallbackExhaustedError);
    const fallbackError = outcome as FallbackExhaustedError;
    expect(fallbackError.attempts.some((attempt) => attempt.error.message.includes('tool-b'))).toBe(
      true,
    );
  });

  it('a slow enabled() predicate times out per middlewareTimeoutMs and the middleware is treated as disabled, without failing the whole call', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const slow: VernLLMMiddleware = {
      name: 'slow-flag-check',
      enabled: () => new Promise(() => {}),
      transform: () => ({ addMessages: [{ role: 'user', content: 'should never appear' }] }),
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [slow],
      middlewareTimeoutMs: 20,
      logger,
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false });

    expect(result).toBe('hi');
    expect(calls[0]!.messages.some((m) => m.content === 'should never appear')).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('FallbackExhaustedError still surfaces normally through wrap when every target fails', async () => {
    const { client: primaryClient } = createMockClient([new FakeApiError('primary down', 500)]);
    const { client: fallbackClient } = createMockClient([new FakeApiError('fallback down', 500)]);

    let observedError: unknown;

    const middleware: VernLLMMiddleware = {
      name: 'observer',
      wrap: async (_request, next) => {
        try {
          return await next();
        } catch (error) {
          observedError = error;
          throw error;
        }
      },
    };

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      middleware: [middleware],
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toBeInstanceOf(
      FallbackExhaustedError,
    );

    expect(observedError).toBeInstanceOf(FallbackExhaustedError);
  });

  it('a genuinely unrecognizable throw is not counted toward the circuit breaker, unlike a real provider failure', async () => {
    const { client } = createMockClient([textResponse('would have worked')]);

    const buggy: VernLLMMiddleware = {
      name: 'buggy',
      transform: () => {
        throw new Error('undefined is not a function');
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      middleware: [buggy],
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    // Trip the "breaker" with a middleware bug, repeatedly, well past the
    // threshold that would open a breaker counting real failures.
    for (let i = 0; i < 5; i++) {
      await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toMatchObject({
        type: 'invalid_params',
        code: 'middleware_threw',
      });
    }

    // The breaker never saw any of those as a countable failure, so it's
    // still closed: getCircuitState confirms it directly.
    expect(llm.getCircuitState()).toBe('closed');
  });

  it("ctx.state read in the outer wrap's pre-next() phase requires the writer to be the inner (later-priority) middleware, unlike a post-next() read which is order independent", async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const spanKey = createStateKey<string>('order-dependent-span');
    let observedBeforeNext: string | undefined;

    // `logs-before-call` is priority 0 (outermost): its pre-next() phase
    // runs before `sets-span-id`'s pre-next() phase ever does, so reading
    // the key here, before calling next(), can only see whatever was
    // already there when this call started: nothing.
    const logsBeforeCall: VernLLMMiddleware = {
      name: 'logs-before-call',
      priority: 0,
      wrap: async (_request, next, ctx) => {
        observedBeforeNext = ctx.state.get(spanKey);
        return next();
      },
    };

    const setsSpanId: VernLLMMiddleware = {
      name: 'sets-span-id',
      priority: 1,
      wrap: async (_request, next, ctx) => {
        ctx.state.set(spanKey, 'span-xyz');
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [logsBeforeCall, setsSpanId],
    });

    await llm.call({ userContent: 'hi', jsonMode: false });

    // The value genuinely isn't there yet at that point in the sequence:
    // this is the "wrong without the right priority" case, not merely an
    // untested one.
    expect(observedBeforeNext).toBeUndefined();
  });

  it('cachedCall: two concurrent callers on the same cacheKey join a single in-flight miss, each still getting exactly one wrap invocation of their own', async () => {
    let resolveCall: (value: unknown) => void;
    const pendingCall = new Promise((resolve) => {
      resolveCall = resolve;
    });

    const { client, create } = createMockClient([() => pendingCall as Promise<never>]);

    let wrapCount = 0;

    const middleware: VernLLMMiddleware = {
      name: 'counter',
      wrap: async (_request, next) => {
        wrapCount++;
        return next();
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    const callParams = {
      cacheKey: 'join-key',
      ttl: 1000,
      call: { userContent: 'hi', jsonMode: false },
    };

    // Both start before either resolves, so the second joins the first's
    // in-flight miss instead of triggering its own.
    const first = llm.cachedCall(callParams);
    const second = llm.cachedCall(callParams);

    resolveCall!(textResponse('joined result'));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe('joined result');
    expect(secondResult).toBe('joined result');
    expect(create).toHaveBeenCalledTimes(1);
    // One wrap invocation for the trigger's own cachedCall(), one more
    // for the joiner's own cachedCall(): never a third for the
    // underlying provider call they shared.
    expect(wrapCount).toBe(2);
  });

  it('CallResult.meta populated for a streaming call the same way it already is for a non-streaming one', async () => {
    const { client: streamClient } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'hi' }],
    ]);
    const { client: nonStreamClient } = createMockClient([textResponse('hi')]);

    let streamingMeta: unknown;
    let nonStreamingMeta: unknown;

    const streamingMiddleware: VernLLMMiddleware = {
      name: 'meta-observer',
      wrap: async (_request, next) => {
        const result = await next();
        streamingMeta = result.meta;
        return result;
      },
    };

    const nonStreamingMiddleware: VernLLMMiddleware = {
      name: 'meta-observer',
      wrap: async (_request, next) => {
        const result = await next();
        nonStreamingMeta = result.meta;
        return result;
      },
    };

    const streamingLlm = new VernLLM({
      client: streamClient,
      model: 'test-model',
      name: 'test-provider',
      middleware: [streamingMiddleware],
    });

    const nonStreamingLlm = new VernLLM({
      client: nonStreamClient,
      model: 'test-model',
      name: 'test-provider',
      middleware: [nonStreamingMiddleware],
    });

    const { finalResult } = await streamingLlm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    await finalResult;
    await nonStreamingLlm.call({ userContent: 'hi', jsonMode: false });

    const expectedMetaShape = {
      provider: 'test-provider',
      model: 'test-model',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
    };

    expect(streamingMeta).toEqual(expectedMetaShape);
    expect(nonStreamingMeta).toEqual(expectedMetaShape);
  });
});
