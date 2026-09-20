import { VernLLM, type Logger, type VernLLMMiddleware } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  byStart,
  createMetricHarness,
  createMockClient,
  createTraceHarness,
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
