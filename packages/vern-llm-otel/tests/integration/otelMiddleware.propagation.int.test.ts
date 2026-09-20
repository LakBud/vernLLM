import {
  context,
  ROOT_CONTEXT,
  trace,
  type Attributes,
  type Context,
  type ContextManager,
  type Meter,
} from '@opentelemetry/api';
import { VernLLM } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  createMetricHarness,
  createMockClient,
  createTraceHarness,
  FakeApiError,
  installContextManager,
  parentIdOf,
  spanId,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

const BASE = { model: 'gpt-4o', maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const call = { userContent: 'hi', jsonMode: false as const };

describe('context propagation', () => {
  let trace_: TraceHarness;
  let meter_: MetricHarness;
  let restore: (() => void) | undefined;

  beforeEach(() => {
    trace_ = createTraceHarness();
    meter_ = createMetricHarness();
  });

  afterEach(async () => {
    restore?.();
    restore = undefined;
    context.disable();
    await Promise.all([trace_.shutdown(), meter_.shutdown()]);
  });

  const middleware = () =>
    otelMiddleware({ tracer: trace_.tracer, meter: meter_.meter, logger: 'silent' });
  const named = (name: string) => trace_.spans().filter((span) => span.name === name);

  describe('with a context manager', () => {
    beforeEach(() => {
      restore = installContextManager();
    });

    it("nests the call under the app's active span, with no configuration", async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [middleware()],
      });

      await trace_.tracer.startActiveSpan('app.request', async (app) => {
        await llm.call(call);
        app.end();
      });

      const [app] = named('app.request');
      const [callSpan] = named('vernllm.call');
      const [attempt] = named('chat gpt-4o');

      expect(parentIdOf(callSpan!)).toBe(spanId(app!));
      expect(parentIdOf(attempt!)).toBe(spanId(callSpan!));
    });

    it('lets an execute_tool span made after the call nest under the app span, not the call', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [middleware()],
      });

      await trace_.tracer.startActiveSpan('app.agent', async (agent) => {
        await llm.call(call);

        // The context is restored once the call ends, so the app's own next span is a sibling.
        expect(trace.getSpan(context.active())).toBe(agent);
        trace_.tracer.startSpan('execute_tool get_weather').end();
        agent.end();
      });

      const [agent] = named('app.agent');
      const [tool] = named('execute_tool get_weather');
      const [callSpan] = named('vernllm.call');

      expect(parentIdOf(tool!)).toBe(spanId(agent!));
      expect(parentIdOf(callSpan!)).toBe(spanId(agent!));
    });

    it('makes work started during the call, like an HTTP client span, a child of the call span', async () => {
      const client = createMockClient([
        async () => {
          trace_.tracer.startSpan('http.client POST').end();
          return textResponse('ok', USAGE);
        },
      ]).client;
      const llm = new VernLLM({ ...BASE, client, middleware: [middleware()] });

      await llm.call(call);

      const [http] = named('http.client POST');
      const [callSpan] = named('vernllm.call');
      expect(parentIdOf(http!)).toBe(spanId(callSpan!));
    });

    it('keeps concurrent calls in their own trees', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [middleware()],
      });

      await Promise.all(
        ['a', 'b'].map((name) =>
          trace_.tracer.startActiveSpan(`app.${name}`, async (app) => {
            await llm.call(call);
            app.end();
          }),
        ),
      );

      for (const name of ['a', 'b']) {
        const [app] = named(`app.${name}`);
        const owned = trace_.spans().filter((span) => parentIdOf(span) === spanId(app!));
        expect(owned.map((span) => span.name)).toEqual(['vernllm.call']);
      }
    });

    it('restores the caller context even when the call fails', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([new FakeApiError('down', 500)]).client,
        middleware: [middleware()],
      });

      await trace_.tracer.startActiveSpan('app.request', async (app) => {
        await expect(llm.call(call)).rejects.toThrow();
        expect(trace.getSpan(context.active())).toBe(app);
        app.end();
      });
    });
  });

  describe('without a context manager', () => {
    it('still parents attempts to the call span, since the context is passed explicitly', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [middleware()],
      });

      await llm.call(call);

      const [callSpan] = named('vernllm.call');
      const [attempt] = named('chat gpt-4o');
      expect(callSpan!.parentSpanContext).toBeUndefined();
      expect(parentIdOf(attempt!)).toBe(spanId(callSpan!));
    });
  });

  describe('with a context manager that cannot run a function in a context', () => {
    it('runs the call directly instead, and still parents attempts to the call span', async () => {
      const errors: unknown[] = [];
      const broken = {
        active: () => ROOT_CONTEXT,
        // Only refuses the context that carries a span, which is the one this package passes. The
        // SDK also runs its own exports through `with`, and those must keep working.
        with: (
          ctx: Context,
          fn: (...args: unknown[]) => unknown,
          thisArg?: unknown,
          ...args: unknown[]
        ) => {
          if (trace.getSpan(ctx)) throw new Error('with is broken');
          return fn.call(thisArg, ...args);
        },
        bind: (_context: Context, target: unknown) => target,
        enable() {
          return this;
        },
        disable() {
          return this;
        },
      } as unknown as ContextManager;
      context.setGlobalContextManager(broken);

      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [
          otelMiddleware({
            tracer: trace_.tracer,
            meter: meter_.meter,
            logger: { debug: () => {}, warn: () => {}, error: (...args) => errors.push(args) },
          }),
        ],
      });

      await expect(llm.call(call)).resolves.toBe('ok');

      const [callSpan] = named('vernllm.call');
      const [attempt] = named('chat gpt-4o');
      expect(parentIdOf(attempt!)).toBe(spanId(callSpan!));
      expect(errors).toHaveLength(1);
      expect((errors[0] as string[])[0]).toBe('[VernLLM] otel: activateContext failed');
      expect(trace_.openSpans()).toEqual([]);
    });
  });

  describe('measurement context', () => {
    interface Recorded {
      name: string;
      context: Context | undefined;
    }

    /** A meter that passes everything through and remembers the context each measurement used. */
    function spyingMeter(real: Meter, recorded: Recorded[]): Meter {
      return {
        createHistogram: (name: string, options?: Parameters<Meter['createHistogram']>[1]) => {
          const histogram = real.createHistogram(name, options);
          return {
            record: (value: number, attributes?: Attributes, ctx?: Context) => {
              recorded.push({ name, context: ctx });
              histogram.record(value, attributes, ctx);
            },
          };
        },
        createCounter: (name: string, options?: Parameters<Meter['createCounter']>[1]) => {
          const counter = real.createCounter(name, options);
          return {
            add: (value: number, attributes?: Attributes, ctx?: Context) => {
              recorded.push({ name, context: ctx });
              counter.add(value, attributes, ctx);
            },
          };
        },
      } as unknown as Meter;
    }

    it('records attempt measurements against the attempt span, not whatever is ambient', async () => {
      restore = installContextManager();
      const recorded: Recorded[] = [];
      const llm = new VernLLM({
        ...BASE,
        maxRetries: 1,
        client: createMockClient([new FakeApiError('down', 500), textResponse('ok', USAGE)]).client,
        middleware: [
          otelMiddleware({
            tracer: trace_.tracer,
            meter: spyingMeter(meter_.meter, recorded),
            logger: 'silent',
          }),
        ],
      });

      await trace_.tracer.startActiveSpan('app.request', async (app) => {
        await llm.call(call);
        app.end();
      });

      const attempts = named('chat gpt-4o');
      const [callSpan] = named('vernllm.call');
      const [app] = named('app.request');
      const spanOf = (ctx: Context | undefined) => trace.getSpan(ctx ?? context.active());
      const idOf = (ctx: Context | undefined) => spanOf(ctx)?.spanContext().spanId;
      const durations = recorded.filter(
        (entry) => entry.name === 'gen_ai.client.operation.duration',
      );
      const tokens = recorded.filter((entry) => entry.name === 'gen_ai.client.token.usage');

      // Each attempt's duration is recorded against that attempt's own span.
      expect(durations.map((entry) => idOf(entry.context))).toEqual(attempts.map(spanId));
      // Tokens arrive while the answering attempt is still open, so they link to it too.
      expect(tokens.map((entry) => idOf(entry.context))).toEqual([
        spanId(attempts[1]!),
        spanId(attempts[1]!),
      ]);

      // Whole call measurements link to the call span.
      const callLevel = recorded.filter((entry) =>
        ['vernllm.call.duration', 'vernllm.call.attempts'].includes(entry.name),
      );
      expect(callLevel.map((entry) => idOf(entry.context))).toEqual([
        spanId(callSpan!),
        spanId(callSpan!),
      ]);

      // None of them fell back to the app's ambient span.
      for (const entry of recorded) expect(idOf(entry.context)).not.toBe(spanId(app!));
    });
  });
});
