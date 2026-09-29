import { describe, expect, it, vi } from 'vitest';

import { type VernLLMEvent, type VernLLMMiddleware } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, createMockStreamingClient, textResponse } from '../../helpers.js';
import { CALL, wrapCounter } from './middleware.int.helpers.js';

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
