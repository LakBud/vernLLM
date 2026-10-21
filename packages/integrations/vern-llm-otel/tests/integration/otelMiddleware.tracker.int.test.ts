import { VernLLM, type Logger, type VernLLMMiddleware } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  byStart,
  createMetricHarness,
  createMockClient,
  createTraceHarness,
  pointsOf,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

import type { OtelMiddlewareOptions } from '../../src/types/index.js';

const BASE = { model: 'gpt-4o', maxRetries: 0, logger: 'silent' as const };
const call = { userContent: 'hi', jsonMode: false as const };

describe('call tracker behaviour outside the scenario table', () => {
  let trace: TraceHarness;
  let meter: MetricHarness;
  let errorLog: ReturnType<typeof vi.fn<Logger['error']>>;
  let logger: Logger;

  beforeEach(() => {
    trace = createTraceHarness();
    meter = createMetricHarness();
    errorLog = vi.fn<Logger['error']>();
    logger = { debug: () => {}, warn: () => {}, error: errorLog };
  });

  afterEach(async () => {
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  const otel = (options: OtelMiddlewareOptions = {}) =>
    otelMiddleware({ tracer: trace.tracer, meter: meter.meter, logger, ...options });

  it('never changes the request the provider receives', async () => {
    const withOtel = createMockClient([textResponse('ok')]);
    const without = createMockClient([textResponse('ok')]);

    await new VernLLM({ ...BASE, client: withOtel.client, middleware: [otel()] }).call(call);
    await new VernLLM({ ...BASE, client: without.client }).call(call);

    expect(withOtel.calls).toEqual(without.calls);
  });

  it('records middleware events as span events only when asked to', async () => {
    const patcher: VernLLMMiddleware = { name: 'patcher', transform: () => ({ temperature: 0.5 }) };
    const run = async (options: OtelMiddlewareOptions) => {
      const t = createTraceHarness();
      const client = createMockClient([textResponse('ok')]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [
          patcher,
          otelMiddleware({ tracer: t.tracer, meter: meter.meter, logger, ...options }),
        ],
      });
      await llm.call(call);
      const callSpan = t.spans().find((span) => span.name === 'vernllm.call');
      await t.shutdown();
      return callSpan!.events;
    };

    expect((await run({})).map((event) => event.name)).toEqual([]);

    const events = await run({ middlewareEvents: true });
    expect(events.map((event) => event.name)).toEqual(['vernllm.middleware']);
    expect(events[0]!.attributes).toMatchObject({
      name: 'patcher',
      hook: 'transform',
      patched_fields: ['temperature'],
    });
  });

  describe('custom events reported through ctx.emit', () => {
    const emitter = (data: unknown = { deployment: 'claude', strategy: 'weighted' }) => {
      const middleware: VernLLMMiddleware = {
        name: 'router',
        wrap: async (_request, next, ctx) => {
          ctx.emit('router.decision', data as never);
          return next();
        },
      };
      return middleware;
    };

    async function callSpanEvents(options: OtelMiddlewareOptions, data?: unknown) {
      const t = createTraceHarness();
      const client = createMockClient([textResponse('ok')]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [
          otelMiddleware({ tracer: t.tracer, meter: meter.meter, logger, ...options }),
          emitter(data),
        ],
      });

      await llm.call(call);
      const callSpan = t.spans().find((span) => span.name === 'vernllm.call');
      await t.shutdown();

      return callSpan!.events;
    }

    it('records a span event named after the event, with its source, and no data by default', async () => {
      const events = await callSpanEvents({});

      expect(events.map((event) => event.name)).toEqual(['router.decision']);
      expect(events[0]!.attributes).toEqual({ 'vernllm.event.source': 'router' });
    });

    it('records the data as JSON only when customEvents.data is on', async () => {
      const events = await callSpanEvents({ customEvents: { data: true } });

      expect(events[0]!.attributes).toEqual({
        'vernllm.event.source': 'router',
        'vernllm.event.data': '{"deployment":"claude","strategy":"weighted"}',
      });
    });

    it('cuts long data to customEvents.maxLength', async () => {
      const events = await callSpanEvents(
        { customEvents: { data: true, maxLength: 60 } },
        { note: 'x'.repeat(500) },
      );

      const data = events[0]!.attributes?.['vernllm.event.data'] as string;
      expect(data.length).toBeLessThanOrEqual(60);
      expect(data.endsWith('…[truncated]')).toBe(true);
    });

    it('records nothing when customEvents is false', async () => {
      expect(await callSpanEvents({ customEvents: false })).toEqual([]);
    });

    it('records nothing for an event the core dropped as invalid, and the call still succeeds', async () => {
      expect(await callSpanEvents({}, { value: Number.NaN })).toEqual([]);
    });

    it('adds no metric for a custom event', async () => {
      await callSpanEvents({});

      const collected = await meter.collect();
      expect([...collected.keys()].filter((name) => name.includes('custom'))).toEqual([]);
    });

    it('records events from every middleware, each with its own source, next to middleware events', async () => {
      const t = createTraceHarness();
      const client = createMockClient([textResponse('ok')]).client;
      const second: VernLLMMiddleware = {
        name: 'audit',
        transform: (_request, ctx) => {
          ctx.emit('audit.note');
          return { temperature: 0.5 };
        },
      };
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [
          otelMiddleware({
            tracer: t.tracer,
            meter: meter.meter,
            logger,
            middlewareEvents: true,
          }),
          emitter(),
          second,
        ],
      });

      await llm.call(call);
      const callSpan = t.spans().find((span) => span.name === 'vernllm.call')!;
      await t.shutdown();

      expect(callSpan.events.map((event) => event.name)).toEqual([
        'router.decision',
        'audit.note',
        'vernllm.middleware',
      ]);
      expect(callSpan.events.map((event) => event.attributes?.['vernllm.event.source'])).toEqual([
        'router',
        'audit',
        undefined,
      ]);
    });
  });

  describe('cache token attributes', () => {
    it('records the cache split on the attempt span from a real cached response', async () => {
      const client = createMockClient([
        textResponse('ok', {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
        }),
      ]).client;
      const llm = new VernLLM({ ...BASE, client, middleware: [otel()] });

      await llm.call(call);

      const attempt = trace.spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes).toMatchObject({
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 5,
        'gen_ai.usage.cache_read.input_tokens': 60,
        'gen_ai.usage.cache_write.input_tokens': 30,
      });
    });

    it('leaves the token usage metric on input and output only, as the convention defines', async () => {
      const client = createMockClient([
        textResponse('ok', {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 60 },
        }),
      ]).client;
      const llm = new VernLLM({ ...BASE, client, middleware: [otel()] });

      await llm.call(call);

      const points = pointsOf((await meter.collect()).get('gen_ai.client.token.usage'));
      expect(points.map((point) => point.attributes['gen_ai.token.type']).sort()).toEqual([
        'input',
        'output',
      ]);
      expect(
        points.find((point) => point.attributes['gen_ai.token.type'] === 'input')!.value,
      ).toMatchObject({
        sum: 100,
      });
    });

    it('sets no cache attribute when the provider reports no cache counts', async () => {
      const client = createMockClient([
        textResponse('ok', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }),
      ]).client;
      const llm = new VernLLM({ ...BASE, client, middleware: [otel()] });

      await llm.call(call);

      const attempt = trace.spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes).not.toHaveProperty('gen_ai.usage.cache_read.input_tokens');
      expect(attempt.attributes).not.toHaveProperty('gen_ai.usage.cache_write.input_tokens');
    });
  });

  it('ends the call instead of leaking it when a stream result cannot be observed', async () => {
    const hostile: VernLLMMiddleware = {
      name: 'hostile',
      wrap: async () => ({
        value: {
          chunks: (async function* () {})(),
          finalResult: {
            then() {
              throw new Error('cannot observe this promise');
            },
          },
        },
      }),
    };
    const client = createMockClient([textResponse('unused')]).client;
    const llm = new VernLLM({ ...BASE, client, middleware: [hostile, otel()] });

    await expect(llm.call(call)).resolves.toBeDefined();

    expect(trace.openSpans()).toEqual([]);
    expect(byStart(trace.spans()).map((span) => span.name)).toEqual(['vernllm.call']);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      '[VernLLM] otel: finish failed',
      expect.objectContaining({ message: 'cannot observe this promise' }),
    );
  });
});

describe('registration', () => {
  const client = () => createMockClient([textResponse('ok')]).client;

  it('rejects two instances in one VernLLM, through the core duplicate ref check', () => {
    expect(
      () =>
        new VernLLM({
          ...BASE,
          client: client(),
          middleware: [otelMiddleware(), otelMiddleware()],
        }),
    ).toThrow();
  });

  it('lets one middleware object serve several VernLLM instances without crossing their calls', async () => {
    const trace = createTraceHarness();
    const meter = createMetricHarness();
    const shared = otelMiddleware({ tracer: trace.tracer, meter: meter.meter, logger: 'silent' });

    const first = new VernLLM({ ...BASE, client: client(), middleware: [shared] });
    const second = new VernLLM({ ...BASE, client: client(), middleware: [shared] });

    await Promise.all([first.call(call), second.call(call), first.call(call), second.call(call)]);

    const spans = trace.spans();
    const calls = spans.filter((span) => span.name === 'vernllm.call');
    const attempts = spans.filter((span) => span.name === 'chat gpt-4o');

    expect(calls).toHaveLength(4);
    expect(attempts).toHaveLength(4);
    // Every attempt belongs to a distinct call, so no state leaked between instances.
    const parents = new Set(attempts.map((span) => span.parentSpanContext?.spanId));
    expect(parents.size).toBe(4);
    expect(trace.openSpans()).toEqual([]);

    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });
});
