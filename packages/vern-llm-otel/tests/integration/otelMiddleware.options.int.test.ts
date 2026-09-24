import { SpanKind } from '@opentelemetry/api';
import { VernLLM, type Logger } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  byStart,
  createMetricHarness,
  createMockClient,
  createMockStreamingClient,
  createTraceHarness,
  FakeApiError,
  pointsOf,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

import type { OtelMiddlewareOptions } from '../../src/types/index.js';

const BASE = { model: 'gpt-4o', maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const call = { userContent: 'hi', jsonMode: false as const };

describe('options that change what is emitted', () => {
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

  const spans = () => byStart(trace.spans());

  /** A call that retries, falls back, and answers, so every kind of span and metric appears. */
  async function busyCall(options: OtelMiddlewareOptions, model = 'gpt-4o') {
    const llm = new VernLLM({
      ...BASE,
      model,
      maxRetries: 1,
      client: createMockClient([new FakeApiError('down', 500)]).client,
      fallback: { client: createMockClient([textResponse('ok', USAGE)]).client, model: 'claude-x' },
      middleware: [otel(options)],
    });

    await llm.call(call);
  }

  describe('genAiConventions: false', () => {
    it('emits no gen_ai attribute on any span, and keeps the vernllm ones', async () => {
      await busyCall({ genAiConventions: false, captureContent: true });

      expect(spans().length).toBeGreaterThan(1);
      for (const span of spans()) {
        expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
      }

      const attempts = spans().filter((span) => span.name === 'vernllm.attempt');
      expect(attempts).toHaveLength(3);
      expect(attempts[0]!.attributes).toMatchObject({
        'vernllm.target': 'primary',
        'vernllm.attempt': 1,
        'vernllm.is_fallback': false,
      });
      expect(attempts[2]!.attributes['vernllm.is_fallback']).toBe(true);
    });

    it('turns attempt spans into INTERNAL vernllm.attempt spans', async () => {
      await busyCall({ genAiConventions: false });

      expect(spans().map((span) => span.name)).toEqual([
        'vernllm.call',
        'vernllm.attempt',
        'vernllm.attempt',
        'vernllm.attempt',
      ]);
      expect(spans().every((span) => span.kind === SpanKind.INTERNAL)).toBe(true);
    });

    it('still reports errors the standard way', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([new FakeApiError('down', 500)]).client,
        middleware: [otel({ genAiConventions: false })],
      });

      await expect(llm.call(call)).rejects.toThrow();

      for (const span of spans()) {
        expect(span.attributes['error.type']).toBe('server_error');
      }
    });

    it('does not mark a stream with a gen_ai attribute', async () => {
      const { client } = createMockStreamingClient([
        [
          { type: 'text-delta', delta: 'hi' },
          { type: 'usage', usage: USAGE },
        ],
      ]);
      const llm = new VernLLM({ ...BASE, client, middleware: [otel({ genAiConventions: false })] });

      const { finalResult } = await llm.call({ ...call, stream: true });
      await finalResult;
      await new Promise((resolve) => setTimeout(resolve, 5));

      const callSpan = spans().find((span) => span.name === 'vernllm.call')!;
      expect(callSpan.attributes['vernllm.streaming']).toBe(true);
      for (const span of spans())
        expect(span.attributes).not.toHaveProperty('gen_ai.request.stream');
    });

    it('emits no gen_ai metric and keeps every vernllm one', async () => {
      await busyCall({ genAiConventions: false });
      const names = [...(await meter.collect()).keys()].sort();

      expect(names.filter((name) => name.startsWith('gen_ai.'))).toEqual([]);
      expect(names).toEqual([
        'vernllm.call.attempts',
        'vernllm.call.duration',
        'vernllm.fallback.count',
        'vernllm.retry.count',
        'vernllm.retry.delay',
      ]);
    });
  });

  describe('reasoning level', () => {
    it('sends the exact effort under the GenAI name and the VernLLM name', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [otel()],
      });

      await llm.call({ ...call, reasoningEffort: 'high' });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes['gen_ai.request.reasoning.level']).toBe('high');
      expect(attempt.attributes['vernllm.request.reasoning_effort']).toBe('high');
    });

    it('leaves it out when no effort was set, and with GenAI conventions off', async () => {
      const plain = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [otel()],
      });
      await plain.call(call);

      const withEffort = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [otel({ genAiConventions: false })],
      });
      await withEffort.call({ ...call, reasoningEffort: 'low' });

      const [plainAttempt] = spans().filter((span) => span.name === 'chat gpt-4o');
      expect(plainAttempt!.attributes).not.toHaveProperty('gen_ai.request.reasoning.level');

      const [offAttempt] = spans().filter((span) => span.name === 'vernllm.attempt');
      expect(offAttempt!.attributes).not.toHaveProperty('gen_ai.request.reasoning.level');
      expect(offAttempt!.attributes['vernllm.request.reasoning_effort']).toBe('low');
    });
  });

  describe('time to first chunk on the span', () => {
    const streamed = async (options: OtelMiddlewareOptions) => {
      const { client } = createMockStreamingClient([
        async function* () {
          await new Promise((resolve) => setTimeout(resolve, 15));
          yield { type: 'text-delta' as const, delta: 'hi' };
          yield { type: 'usage' as const, usage: USAGE };
        },
      ]);
      const llm = new VernLLM({ ...BASE, client, middleware: [otel(options)] });

      const { finalResult } = await llm.call({ ...call, stream: true });
      await finalResult;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    it('is the same measurement as the metric, on the attempt span only', async () => {
      await streamed({});

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      const callSpan = spans().find((span) => span.name === 'vernllm.call')!;
      const seconds = attempt.attributes['gen_ai.response.time_to_first_chunk'];

      expect(typeof seconds).toBe('number');
      expect(seconds as number).toBeGreaterThan(0.01);
      expect(callSpan.attributes).not.toHaveProperty('gen_ai.response.time_to_first_chunk');

      const [point] = pointsOf(
        (await meter.collect()).get('gen_ai.client.operation.time_to_first_chunk'),
      );
      expect((point!.value as { sum: number }).sum).toBe(seconds);
    });

    it('is absent for a call that does not stream', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        middleware: [otel()],
      });

      await llm.call(call);

      for (const span of spans()) {
        expect(span.attributes).not.toHaveProperty('gen_ai.response.time_to_first_chunk');
      }
    });

    it('is absent with GenAI conventions off', async () => {
      await streamed({ genAiConventions: false });

      for (const span of spans()) {
        expect(span.attributes).not.toHaveProperty('gen_ai.response.time_to_first_chunk');
      }
    });
  });

  describe('metrics: false', () => {
    it('emits no metric at all, and the spans are unaffected', async () => {
      await busyCall({ metrics: false });

      expect((await meter.collect()).size).toBe(0);
      expect(spans().map((span) => span.name)).toContain('vernllm.call');
      expect(errorLog).not.toHaveBeenCalled();
    });
  });

  describe('normalizeModel', () => {
    const fineTuned = 'ft:gpt-4o:acme';
    const collapse = (model: string) => model.split(':')[0]!;

    it('normalizes metric attributes and leaves the spans with the exact model', async () => {
      await busyCall({ normalizeModel: collapse }, fineTuned);

      const attempt = spans().find((span) => span.name === `chat ${fineTuned}`);
      expect(attempt?.attributes['gen_ai.request.model']).toBe(fineTuned);
      expect(spans().find((span) => span.name === 'vernllm.call')?.attributes).toMatchObject({
        'vernllm.primary.model': fineTuned,
      });

      const collected = await meter.collect();
      const seen = new Set<unknown>();
      for (const [name, metric] of collected) {
        for (const point of pointsOf(metric)) {
          for (const key of ['gen_ai.request.model', 'vernllm.model']) {
            if (key in point.attributes) seen.add(`${name}:${String(point.attributes[key])}`);
          }
        }
      }

      const modelsSeen = [...seen].map((entry) => String(entry).split(':').slice(1).join(':'));
      expect(modelsSeen.length).toBeGreaterThan(0);
      expect(modelsSeen).not.toContain(fineTuned);
      expect(modelsSeen).toContain('ft');
      expect(modelsSeen).toContain('claude-x');
    });

    it('falls back to the raw model when the normalizer throws, and the call is unaffected', async () => {
      await busyCall(
        {
          normalizeModel: () => {
            throw new Error('normalizer broke');
          },
        },
        fineTuned,
      );

      const durations = pointsOf((await meter.collect()).get('gen_ai.client.operation.duration'));
      expect(durations.map((point) => point.attributes['gen_ai.request.model'])).toContain(
        fineTuned,
      );
      expect(errorLog).toHaveBeenCalledWith(
        '[VernLLM] otel: normalizeModel failed',
        expect.objectContaining({ message: 'normalizer broke' }),
      );
    });
  });

  describe('providerNames', () => {
    it('infers the provider from the model when nothing is mapped, never using the label', async () => {
      await busyCall({});

      const providers = spans()
        .filter((span) => span.name.startsWith('chat '))
        .map((span) => span.attributes['gen_ai.provider.name']);

      expect(providers).toEqual(['openai', 'openai', 'anthropic']);
    });

    it('uses _OTHER for a model it cannot place', async () => {
      await busyCall({}, 'llama3:8b');

      const attempt = spans().find((span) => span.name === 'chat llama3:8b');
      expect(attempt?.attributes['gen_ai.provider.name']).toBe('_OTHER');
    });

    it('maps each target it knows and leaves the rest', async () => {
      await busyCall({ providerNames: { primary: 'azure.ai.openai' } });

      const providers = spans()
        .filter((span) => span.name.startsWith('chat '))
        .map((span) => span.attributes['gen_ai.provider.name']);

      expect(providers).toEqual(['azure.ai.openai', 'azure.ai.openai', 'anthropic']);
      // The raw label is still available next to the mapped name.
      expect(spans()[1]!.attributes['vernllm.target']).toBe('primary');
    });
  });
});
