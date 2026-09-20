import { context, metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { VernLLM, type Logger, type VernLLMMiddleware } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  createMetricHarness,
  createMockClient,
  createMockStreamingClient,
  createTraceHarness,
  describeOutcome,
  FakeApiError,
  settleOutcome,
  sleep,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

const BASE = { model: 'gpt-4o', maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const call = { userContent: 'hi', jsonMode: false as const };

describe('failure isolation and delivery', () => {
  let trace_: TraceHarness;
  let meter_: MetricHarness;
  let errorLog: ReturnType<typeof vi.fn<Logger['error']>>;
  let logger: Logger;

  beforeEach(() => {
    trace_ = createTraceHarness();
    meter_ = createMetricHarness();
    errorLog = vi.fn<Logger['error']>();
    logger = { debug: () => {}, warn: () => {}, error: errorLog };
  });

  afterEach(async () => {
    trace.disable();
    metrics.disable();
    context.disable();
    await Promise.all([trace_.shutdown(), meter_.shutdown()]);
  });

  const failingClient = () => createMockClient([new FakeApiError('provider said no', 500)]).client;
  const okClient = () => createMockClient([textResponse('ok', USAGE)]).client;

  /** Runs `execute` with and without the middleware and asserts the caller cannot tell. */
  async function expectSameOutcome(
    build: (middleware: VernLLMMiddleware[]) => { call: () => Promise<unknown> },
    middleware: VernLLMMiddleware,
  ) {
    const baseline = describeOutcome(await settleOutcome(build([]).call()));
    const observed = describeOutcome(await settleOutcome(build([middleware]).call()));
    expect(observed).toEqual(baseline);
    return observed;
  }

  describe('a tracer that breaks', () => {
    const throwingTracer = {
      startSpan: () => {
        throw new Error('tracer broke');
      },
    } as unknown as Tracer;

    it.each([
      ['succeeds', okClient, 'ok'],
      ['fails', failingClient, undefined],
    ])('does not change a call that %s', async (_label, makeClient, value) => {
      const outcome = await expectSameOutcome(
        (middleware) => {
          const llm = new VernLLM({ ...BASE, client: makeClient(), middleware });
          return { call: () => llm.call(call) };
        },
        otelMiddleware({ tracer: throwingTracer, meter: meter_.meter, logger }),
      );

      if (value !== undefined) expect(outcome).toEqual({ ok: true, value });
      expect(errorLog).toHaveBeenCalled();
      expect(errorLog.mock.calls[0]![0]).toBe('[VernLLM] otel: startCall failed');
    });

    it('does not change a streaming call either', async () => {
      const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hi' }]]);
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [otelMiddleware({ tracer: throwingTracer, meter: meter_.meter, logger })],
      });

      const { chunks, finalResult } = await llm.call({ ...call, stream: true });
      const seen: unknown[] = [];
      for await (const chunk of chunks) seen.push(chunk);

      expect(seen.length).toBeGreaterThan(0);
      await expect(finalResult).resolves.toBe('hi');
    });
  });

  describe('spans whose methods break', () => {
    // Everything but the calls that end a span and report its identity throws.
    const brokenSpans = (real: Tracer): Tracer =>
      ({
        startSpan: (...args: Parameters<Tracer['startSpan']>) => {
          const span = real.startSpan(...args);
          return new Proxy(span, {
            get(target, property) {
              const value = Reflect.get(target, property) as unknown;
              if (typeof value !== 'function') return value;
              if (property === 'end' || property === 'spanContext' || property === 'isRecording') {
                return value.bind(target);
              }
              return () => {
                throw new Error(`span.${String(property)} broke`);
              };
            },
          });
        },
      }) as unknown as Tracer;

    it.each([
      ['succeeds', okClient],
      ['fails', failingClient],
    ])('never changes a call that %s, and leaves no span open', async (_label, makeClient) => {
      await expectSameOutcome(
        (middleware) => {
          const llm = new VernLLM({ ...BASE, client: makeClient(), middleware });
          return { call: () => llm.call(call) };
        },
        otelMiddleware({ tracer: brokenSpans(trace_.tracer), meter: meter_.meter, logger }),
      );

      expect(trace_.openSpans()).toEqual([]);
      expect(trace_.spans().length).toBeGreaterThan(0);
      expect(errorLog).toHaveBeenCalled();

      // Failed span writes must not cost the measurements that come after them.
      const collected = await meter_.collect();
      expect(collected.has('vernllm.call.duration')).toBe(true);
      expect(collected.has('gen_ai.client.operation.duration')).toBe(true);
    });

    it('still ends a retried call cleanly', async () => {
      const client = createMockClient([
        new FakeApiError('down', 500),
        textResponse('ok', USAGE),
      ]).client;
      const llm = new VernLLM({
        ...BASE,
        maxRetries: 1,
        client,
        middleware: [
          otelMiddleware({ tracer: brokenSpans(trace_.tracer), meter: meter_.meter, logger }),
        ],
      });

      await expect(llm.call(call)).resolves.toBe('ok');
      expect(trace_.openSpans()).toEqual([]);
    });
  });

  describe('a meter that breaks', () => {
    const brokenMeter = {
      createHistogram: () => ({
        record: () => {
          throw new Error('histogram broke');
        },
      }),
      createCounter: () => {
        throw new Error('no counters');
      },
    } as unknown as Meter;

    it.each([
      ['succeeds', okClient],
      ['fails', failingClient],
    ])('never changes a call that %s, and the spans are unaffected', async (_label, makeClient) => {
      await expectSameOutcome(
        (middleware) => {
          const llm = new VernLLM({ ...BASE, client: makeClient(), middleware });
          return { call: () => llm.call(call) };
        },
        otelMiddleware({ tracer: trace_.tracer, meter: brokenMeter, logger }),
      );

      expect(trace_.openSpans()).toEqual([]);
      expect(trace_.spans().map((span) => span.name)).toContain('vernllm.call');
      expect(errorLog).toHaveBeenCalled();
    });
  });

  describe('a logger that breaks', () => {
    it('cannot break a call even while everything else is failing too', async () => {
      const throwingLogger: Logger = {
        debug: () => {},
        warn: () => {},
        error: () => {
          throw new Error('logger down');
        },
      };
      const tracer = {
        startSpan: () => {
          throw new Error('tracer broke');
        },
      } as unknown as Tracer;

      await expectSameOutcome(
        (middleware) => {
          const llm = new VernLLM({ ...BASE, client: okClient(), middleware });
          return { call: () => llm.call(call) };
        },
        otelMiddleware({ tracer, meter: meter_.meter, logger: throwingLogger }),
      );
    });
  });

  describe('a user callback that breaks', () => {
    it('drops the extra attributes and keeps the call and its spans', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: okClient(),
        middleware: [
          otelMiddleware({
            tracer: trace_.tracer,
            meter: meter_.meter,
            logger,
            attributes: () => {
              throw new Error('hook broke');
            },
          }),
        ],
      });

      await expect(llm.call(call)).resolves.toBe('ok');

      const callSpan = trace_.spans().find((span) => span.name === 'vernllm.call')!;
      expect(callSpan.attributes['vernllm.total_attempts']).toBe(1);
      expect(errorLog).toHaveBeenCalledWith(
        '[VernLLM] otel: attributes failed',
        expect.objectContaining({ message: 'hook broke' }),
      );
    });

    it('records the extra attributes when the hook works, and keeps only usable values', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: okClient(),
        middleware: [
          otelMiddleware({
            tracer: trace_.tracer,
            meter: meter_.meter,
            logger,
            attributes: () => ({
              'gen_ai.conversation.id': 'conv_1',
              'app.tenant': 'acme',
              'app.nested': { secret: 'x' } as never,
              'vernllm.total_attempts': 999,
            }),
          }),
        ],
      });

      await llm.call(call);

      const attributes = trace_.spans().find((span) => span.name === 'vernllm.call')!.attributes;
      expect(attributes['gen_ai.conversation.id']).toBe('conv_1');
      expect(attributes['app.tenant']).toBe('acme');
      expect(attributes).not.toHaveProperty('app.nested');
      // Ours are written after the user's, so a custom attribute cannot overwrite them.
      expect(attributes['vernllm.total_attempts']).toBe(1);
    });
  });

  describe('delivery guarantee', () => {
    it('keeps token attributes on the attempt span even when another entry has a slow async enabled', async () => {
      // The core delivers events to entries with an async predicate late. Ours is static, so its
      // usage event must still arrive before the call returns.
      const slowGate: VernLLMMiddleware = {
        name: 'slow-gate',
        enabled: async () => {
          await sleep(40);
          return true;
        },
        onEvent: () => {},
      };
      const llm = new VernLLM({
        ...BASE,
        client: okClient(),
        middleware: [
          slowGate,
          otelMiddleware({ tracer: trace_.tracer, meter: meter_.meter, logger }),
        ],
      });

      await llm.call(call);

      const attempt = trace_.spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes['gen_ai.usage.input_tokens']).toBe(3);
      expect(attempt.attributes['gen_ai.usage.output_tokens']).toBe(4);
      expect(trace_.openSpans()).toEqual([]);
    });

    it('holds for a stream as well', async () => {
      const slowGate: VernLLMMiddleware = {
        name: 'slow-gate',
        enabled: async () => {
          await sleep(40);
          return true;
        },
        onEvent: () => {},
      };
      const { client } = createMockStreamingClient([
        [
          { type: 'text-delta', delta: 'hi' },
          { type: 'usage', usage: USAGE },
        ],
      ]);
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [
          slowGate,
          otelMiddleware({ tracer: trace_.tracer, meter: meter_.meter, logger }),
        ],
      });

      const { finalResult } = await llm.call({ ...call, stream: true });
      await finalResult;
      await sleep(5);

      const attempt = trace_.spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes['gen_ai.usage.input_tokens']).toBe(3);
    });
  });

  describe('with no SDK registered', () => {
    it.each([
      ['succeeds', okClient],
      ['fails', failingClient],
    ])('behaves identically when a call %s, and logs nothing', async (_label, makeClient) => {
      await expectSameOutcome((middleware) => {
        const llm = new VernLLM({ ...BASE, client: makeClient(), middleware });
        return { call: () => llm.call(call) };
      }, otelMiddleware({ logger }));

      expect(errorLog).not.toHaveBeenCalled();
    });

    it('handles a stream and a retry with the API unregistered', async () => {
      const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hi' }]]);
      const llm = new VernLLM({ ...BASE, client, middleware: [otelMiddleware({ logger })] });

      const { finalResult } = await llm.call({ ...call, stream: true });
      await expect(finalResult).resolves.toBe('hi');

      const retried = new VernLLM({
        ...BASE,
        maxRetries: 1,
        client: createMockClient([new FakeApiError('down', 500), textResponse('ok')]).client,
        middleware: [otelMiddleware({ logger })],
      });
      await expect(retried.call(call)).resolves.toBe('ok');
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('uses a provider registered after the middleware was built', async () => {
      const middleware = otelMiddleware({ logger });
      const llm = new VernLLM({ ...BASE, client: okClient(), middleware: [middleware] });

      trace.setGlobalTracerProvider(trace_.provider);
      await llm.call(call);

      expect(trace_.spans().map((span) => span.name)).toEqual(['chat gpt-4o', 'vernllm.call']);
    });
  });
});
