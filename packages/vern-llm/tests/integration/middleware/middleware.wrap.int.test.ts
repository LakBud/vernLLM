import { describe, expect, it } from 'vitest';

import { FallbackExhaustedError } from '../../../src/types/fallback.js';
import { createStateKey, type VernLLMMiddleware } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  FakeApiError,
  textResponse,
} from '../../helpers.js';
import { CALL, fallbackChain, metaRecorder, wrapCounter } from './middleware.int.helpers.js';

describe('middleware wrap', () => {
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

    const { finalResult } = await llm.call({ ...CALL, stream: true });

    await expect(finalResult).resolves.toBe('hello world');
    // wrap:after fires once the stream has opened, matching `runFallbackChain`'s contract.
    // Content that arrives later is observed through finalResult.
    expect(events).toEqual(['wrap:before', 'wrap:after']);
    expect(calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'appended' });
  });

  describe('across a fallback chain', () => {
    it("fires once, sees only the primary in its own ctx, and gets the answering target from next()'s meta", async () => {
      const chain = fallbackChain(
        [new FakeApiError('primary down', 500)],
        [textResponse('from fallback')],
      );
      const seenProviders: string[] = [];
      let observedMeta: unknown;
      let wrapCount = 0;

      const middleware: VernLLMMiddleware = {
        name: 'observer',
        wrap: async (_request, next, ctx) => {
          wrapCount++;
          // wrap's ctx is a PreDispatchContext: it describes the primary target by construction.
          seenProviders.push(ctx.primaryProvider);
          const result = await next();
          observedMeta = result.meta;
          return result;
        },
      };

      const llm = new VernLLM({ ...chain.options, middleware: [middleware] });

      await expect(llm.call(CALL)).resolves.toBe('from fallback');

      expect(wrapCount).toBe(1);
      expect(seenProviders).toEqual(['primary']);
      expect(observedMeta).toMatchObject({
        provider: 'fallback',
        usedFallback: true,
        fallbackIndex: 0,
      });
    });

    it('a wrap serving a canned answer never touches either target', async () => {
      const chain = fallbackChain([textResponse('unused')], [textResponse('unused')]);

      const llm = new VernLLM({
        ...chain.options,
        middleware: [{ name: 'canned-response', wrap: async () => ({ value: 'pong' }) }],
      });

      await expect(llm.call({ userContent: 'ping', jsonMode: false })).resolves.toBe('pong');

      expect(chain.primary.create).not.toHaveBeenCalled();
      expect(chain.fallback.create).not.toHaveBeenCalled();
    });

    it('sees FallbackExhaustedError through next() when every target fails', async () => {
      const chain = fallbackChain(
        [new FakeApiError('primary down', 500)],
        [new FakeApiError('fallback down', 500)],
      );
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

      const llm = new VernLLM({ ...chain.options, middleware: [middleware] });

      await expect(llm.call(CALL)).rejects.toBeInstanceOf(FallbackExhaustedError);

      expect(observedError).toBeInstanceOf(FallbackExhaustedError);
    });
  });

  it('still fires once per call when an open breaker rejects the call before any attempt', async () => {
    const { client, create } = createMockClient([new FakeApiError('down', 500)]);
    const counter = wrapCounter();

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      logger: 'silent',
      middleware: [counter.middleware],
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    // The first call fails at the provider and trips the breaker.
    await expect(llm.call(CALL)).rejects.toThrow();
    expect(counter.count()).toBe(1);

    // The second is rejected by the open breaker before any attempt, and is still wrapped.
    await expect(llm.call(CALL)).rejects.toMatchObject({ type: 'circuit_open' });
    expect(counter.count()).toBe(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  describe('composition', () => {
    it('two middleware compose transform and wrap against a real retry that eventually succeeds', async () => {
      const { client, calls } = createMockClient([
        new FakeApiError('temporary', 500),
        textResponse('recovered'),
      ]);
      const trace: string[] = [];
      const spanKey = createStateKey<string>('span');
      let stateSeenByInner: string | undefined;

      const tracing: VernLLMMiddleware = {
        name: 'tracing',
        priority: 0,
        transform: (_request, ctx) => {
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
          // `tracing` has the lower priority, so it is outermost and its pre next() phase
          // finishes before this one starts.
          stateSeenByInner = ctx.state.get(spanKey);
          return next();
        },
      };

      const llm = new VernLLM({
        client,
        model: 'test-model',
        maxRetries: 1,
        baseDelayMs: 1,
        logger: 'silent',
        middleware: [tracing, costTracking],
      });

      await expect(llm.call(CALL)).resolves.toBe('recovered');

      expect(calls).toHaveLength(2);
      expect(stateSeenByInner).toBe('span-abc');
      // transform re-runs for every real attempt. wrap runs once for the whole logical call.
      expect(trace).toEqual([
        'wrap:start',
        'transform:attempt-1',
        'transform:attempt-2',
        'wrap:end',
      ]);
    });

    it('state set by an inner wrap is invisible to the outer wrap before next() and visible after it', async () => {
      const { client } = createMockClient([textResponse('hi')]);
      const spanKey = createStateKey<string>('order-dependent-span');
      let beforeNext: string | undefined;
      let afterNext: string | undefined;

      // Priority 0 is outermost: its pre next() phase runs before the inner wrap has set anything.
      const outer: VernLLMMiddleware = {
        name: 'logs-around-call',
        priority: 0,
        wrap: async (_request, next, ctx) => {
          beforeNext = ctx.state.get(spanKey);
          const result = await next();
          afterNext = ctx.state.get(spanKey);
          return result;
        },
      };

      const inner: VernLLMMiddleware = {
        name: 'sets-span-id',
        priority: 1,
        wrap: async (_request, next, ctx) => {
          ctx.state.set(spanKey, 'span-xyz');
          return next();
        },
      };

      const llm = new VernLLM({ client, model: 'test-model', middleware: [outer, inner] });

      await llm.call(CALL);

      expect(beforeNext).toBeUndefined();
      expect(afterNext).toBe('span-xyz');
    });

    it("an outermost claimant's wrap nesting follows registration order, not its transform priority", async () => {
      const { client } = createMockClient([textResponse('hi')]);
      const events: string[] = [];

      const claimant = (name: string, priority: number): VernLLMMiddleware => ({
        name,
        position: 'outermost',
        priority,
        wrap: async (_request, next) => {
          events.push(`${name}:before`);
          const result = await next();
          events.push(`${name}:after`);
          return result;
        },
      });

      // `late` has the higher priority, so it transforms last. It was registered first, so it
      // still holds the outermost wrap slot.
      const llm = new VernLLM({
        client,
        model: 'test-model',
        middleware: [claimant('late', 1000), claimant('early', -1000)],
      });

      await llm.call(CALL);

      expect(events).toEqual(['late:before', 'early:before', 'early:after', 'late:after']);
    });
  });

  it('gives a stream the same meta a non streaming call gets', async () => {
    const { client: streamClient } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'hi' }],
    ]);
    const { client: plainClient } = createMockClient([textResponse('hi')]);
    const streamed = metaRecorder();
    const plain = metaRecorder();
    const options = { model: 'test-model', name: 'test-provider', logger: 'silent' as const };

    const streamingLlm = new VernLLM({
      ...options,
      client: streamClient,
      middleware: [streamed.middleware],
    });
    const plainLlm = new VernLLM({
      ...options,
      client: plainClient,
      middleware: [plain.middleware],
    });

    const { finalResult } = await streamingLlm.call({ ...CALL, stream: true });
    await finalResult;
    await plainLlm.call(CALL);

    expect(plain.meta()).toEqual({
      provider: 'test-provider',
      model: 'test-model',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
    });
    expect(streamed.meta()).toEqual(plain.meta());
  });
});
