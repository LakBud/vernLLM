import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';
import { VernLLM } from 'vern-llm';
import { otelLogFields, otelMiddleware } from 'vern-llm-otel';
import { afterEach, describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink, type CallLogRecord } from '../../src/index.js';
import { createMockClient, createMockStreamingClient, sleep, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
const tracer = provider.getTracer('test');

afterEach(() => {
  exporter.reset();
});

function setup(order: 'logger first' | 'otel first', streaming = false) {
  const sink = memorySink();
  const logger = loggerMiddleware({ sink, logger: 'silent', enrich: [otelLogFields] });
  const otel = otelMiddleware({ tracer, metrics: false });
  const llm = new VernLLM({
    client: streaming
      ? createMockStreamingClient([[{ type: 'text-delta', delta: 'hi' }]]).client
      : createMockClient([textResponse('ok'), new Error('down')]).client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    middleware: order === 'logger first' ? [logger, otel] : [otel, logger],
  });
  return { llm, records: () => sink.entries.map(({ entry }) => entry as CallLogRecord) };
}

const callSpan = () => exporter.getFinishedSpans().find((span) => span.name === 'vernllm.call')!;

describe('trace ids in records', () => {
  for (const order of ['logger first', 'otel first'] as const) {
    it(`carries the call span's ids with the ${order}`, async () => {
      const { llm, records } = setup(order);

      await llm.call(call);

      expect(records()[0]!.fields).toEqual({
        traceId: callSpan().spanContext().traceId,
        spanId: callSpan().spanContext().spanId,
      });
    });

    it(`carries them on a failed call too, with the ${order}`, async () => {
      const { llm, records } = setup(order);
      await llm.call(call);
      await llm.call(call).catch(() => {});

      const failed = exporter.getFinishedSpans().filter((span) => span.name === 'vernllm.call')[1]!;
      expect(records()[1]).toMatchObject({
        outcome: 'error',
        fields: { traceId: failed.spanContext().traceId, spanId: failed.spanContext().spanId },
      });
    });

    it(`carries them on a stream, with the ${order}`, async () => {
      const { llm, records } = setup(order, true);

      const stream = await llm.call({ ...call, stream: true as const });
      await stream.finalResult;
      await sleep(5);

      expect(records()[0]!.fields).toEqual({
        traceId: callSpan().spanContext().traceId,
        spanId: callSpan().spanContext().spanId,
      });
    });
  }

  it('writes no fields when there is no otel middleware', async () => {
    const sink = memorySink();
    const llm = new VernLLM({
      client: createMockClient([textResponse('ok')]).client,
      model: 'gpt-4o',
      logger: 'silent',
      middleware: [loggerMiddleware({ sink, logger: 'silent', enrich: [otelLogFields] })],
    });

    await llm.call(call);

    expect(sink.entries[0]!.entry).not.toHaveProperty('fields');
  });
});
