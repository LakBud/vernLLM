import { describe, expect, it } from 'vitest';

import { type VernLLMEvent } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  FakeApiError,
  textResponse,
} from '../../helpers.js';
import { CALL, fallbackChain, USAGE, withUsage } from './middleware.int.helpers.js';

const context = { tenantId: 't1', routing: { only: ['bedrock'], maxPrice: 10 } };

describe('middleware call context', () => {
  it('is on ctx in every hook and both stages, across a real fallback chain', async () => {
    const chain = fallbackChain([new FakeApiError('down', 500)], [textResponse('from fallback')]);
    const seen: { where: string; context: unknown }[] = [];
    const record = (hook: string, ctx: { stage: string; context: unknown }) =>
      seen.push({ where: `${hook}:${ctx.stage}`, context: ctx.context });

    const llm = new VernLLM({
      ...chain.options,
      middleware: [
        {
          name: 'reader',
          enabled: (ctx) => (record('enabled', ctx), true),
          wrap: async (_request, next, ctx) => (record('wrap', ctx), next()),
          transform: (_request, ctx) => (record('transform', ctx), {}),
          dispatch: async (_request, next, ctx) => (record('dispatch', ctx), void (await next())),
          onEvent: (_event, ctx) => record('onEvent', ctx),
        },
      ],
    });

    await llm.call({ ...CALL, context });

    for (const entry of seen) expect(entry.context).toEqual(context);
    expect(new Set(seen.map((entry) => entry.where))).toEqual(
      new Set([
        'enabled:pre-dispatch',
        'wrap:pre-dispatch',
        'enabled:attempt',
        'transform:attempt',
        'dispatch:attempt',
        'onEvent:attempt',
      ]),
    );
    // One attempt on each target, so the fallback attempt's own hooks saw it too.
    expect(seen.filter((entry) => entry.where === 'transform:attempt')).toHaveLength(2);
    expect(seen.filter((entry) => entry.where === 'dispatch:attempt')).toHaveLength(2);
  });

  it('stamps every event a call reports, and the usage inside a usage event', async () => {
    const { client } = createMockClient([new FakeApiError('temporary', 500), withUsage('ok')]);
    const events: VernLLMEvent[] = [];
    const usages: unknown[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      logger: 'silent',
      onEvent: (event) => void events.push(event),
      onUsage: (usage) => void usages.push(usage),
      middleware: [
        {
          name: 'emitter',
          wrap: async (_request, next, ctx) => {
            ctx.emit('note');
            return next();
          },
        },
      ],
    });

    await llm.call({ ...CALL, context });

    expect(new Set(events.map((event) => event.kind))).toEqual(
      new Set(['retry', 'usage', 'custom']),
    );
    for (const event of events) expect(event.context).toEqual(context);

    const usageEvent = events.find((event) => event.kind === 'usage');
    expect(usageEvent).toMatchObject({ usage: { context, totalTokens: 15 } });
    expect(usages).toEqual([expect.objectContaining({ context, totalTokens: 15 })]);
  });

  it('stamps the fallback event, whose own ctx is built separately', async () => {
    const chain = fallbackChain([new FakeApiError('down', 500)], [textResponse('ok')]);
    const seen: { event: unknown; ctx: unknown }[] = [];

    const llm = new VernLLM({
      ...chain.options,
      middleware: [
        {
          name: 'reader',
          onEvent: (event, ctx) => {
            if (event.kind === 'fallback') seen.push({ event: event.context, ctx: ctx.context });
          },
        },
      ],
    });

    await llm.call({ ...CALL, context });

    expect(seen).toEqual([{ event: context, ctx: context }]);
  });

  it('stamps a circuit_state event from a real trip inside the call, but not from a manual close', async () => {
    const { client } = createMockClient([new FakeApiError('down', 500)]);
    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      logger: 'silent',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      onEvent: (event) => void events.push(event),
    });

    await expect(llm.call({ ...CALL, context })).rejects.toThrow();

    const tripped = events.filter((event) => event.kind === 'circuit_state');
    expect(tripped).toHaveLength(1);
    expect(tripped[0]!.context).toEqual(context);

    events.length = 0;
    llm.closeCircuit();

    const manual = events.filter((event) => event.kind === 'circuit_state');
    expect(manual).toHaveLength(1);
    expect(manual[0]).not.toHaveProperty('context');
  });

  it('stamps a rate_limited event from a real queued attempt', async () => {
    // The first response is slow, so the second call really has to wait for capacity.
    const { client } = createMockClient([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return textResponse('a');
      },
      textResponse('b'),
    ]);
    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: 'silent',
      rateLimit: { maxConcurrent: 1 },
      onEvent: (event) => void events.push(event),
    });

    await Promise.all([
      llm.call({ userContent: 'one', jsonMode: false, context }),
      llm.call({ userContent: 'two', jsonMode: false, context }),
    ]);

    const limited = events.filter((event) => event.kind === 'rate_limited');
    expect(limited.length).toBeGreaterThan(0);
    for (const event of limited) expect(event.context).toEqual(context);
  });

  it('keeps two concurrent calls apart, each seeing only its own context', async () => {
    const { client } = createMockClient([textResponse('a'), textResponse('b')]);
    const seenByCall = new Map<string, unknown>();

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: 'silent',
      middleware: [
        {
          name: 'reader',
          wrap: async (_request, next, ctx) => {
            // Yielding lets the two calls interleave, so a shared slot would be overwritten.
            await new Promise((resolve) => setTimeout(resolve, 5));
            seenByCall.set(ctx.requestId, ctx.context);
            return next();
          },
        },
      ],
    });

    await Promise.all([
      llm.call({ userContent: 'one', jsonMode: false, requestId: 'a', context: { tenantId: 'A' } }),
      llm.call({ userContent: 'two', jsonMode: false, requestId: 'b', context: { tenantId: 'B' } }),
    ]);

    expect(Object.fromEntries(seenByCall)).toEqual({
      a: { tenantId: 'A' },
      b: { tenantId: 'B' },
    });
  });

  it('adds no context field to any event or usage when the call gave none', async () => {
    const { client } = createMockClient([withUsage('ok')]);
    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: 'silent',
      onEvent: (event) => void events.push(event),
    });

    await llm.call(CALL);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).not.toHaveProperty('context');

    const usageEvent = events.find((event) => event.kind === 'usage');
    expect(usageEvent).toMatchObject({ usage: { totalTokens: 15 } });
    expect(usageEvent).not.toHaveProperty('usage.context');
  });

  it('reaches a stream call and the events it reports', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'hello' },
        { type: 'usage', usage: USAGE },
      ],
    ]);
    const events: VernLLMEvent[] = [];
    let wrapContext: unknown;

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: 'silent',
      onEvent: (event) => void events.push(event),
      middleware: [
        {
          name: 'reader',
          wrap: async (_request, next, ctx) => {
            wrapContext = ctx.context;
            return next();
          },
        },
      ],
    });

    const { finalResult } = await llm.call({ ...CALL, stream: true, context });
    await finalResult;

    expect(wrapContext).toEqual(context);
    const usageEvents = events.filter((event) => event.kind === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]!.context).toEqual(context);
  });
});
