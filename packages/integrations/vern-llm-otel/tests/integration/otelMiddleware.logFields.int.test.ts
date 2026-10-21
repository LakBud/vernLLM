import { trace } from '@opentelemetry/api';
import { VernLLM, type PreDispatchContext, type VernLLMMiddleware } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { otelLogFields, otelMiddleware } from '../../src/index.js';
import {
  createMockClient,
  createMockStreamingClient,
  createTraceHarness,
  textResponse,
  type TraceHarness,
} from '../helpers.js';

const BASE = { model: 'gpt-4o', maxRetries: 0, logger: 'silent' as const };
const call = { userContent: 'hi', jsonMode: false as const };

/** Reads the ids from inside the call, as a log enricher would. */
function reader() {
  const seen: Array<Record<string, unknown>> = [];
  const middleware: VernLLMMiddleware = {
    name: 'reader',
    wrap: async (_request, next, ctx) => {
      seen.push(otelLogFields(ctx as PreDispatchContext));
      return next();
    },
  };
  return { seen, middleware };
}

describe('otelLogFields', () => {
  let harness: TraceHarness;

  beforeEach(() => {
    harness = createTraceHarness();
  });
  afterEach(async () => {
    await harness.shutdown();
  });

  it("returns the call span's ids to anything running inside the call", async () => {
    const { seen, middleware } = reader();
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([textResponse('ok')]).client,
      middleware: [otelMiddleware({ tracer: harness.tracer, metrics: false }), middleware],
    });

    await llm.call(call);

    const span = harness.spans().find((item) => item.name === 'vernllm.call')!;
    expect(seen).toEqual([
      { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId },
    ]);
  });

  it('returns nothing without an otel middleware', async () => {
    const { seen, middleware } = reader();
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([textResponse('ok')]).client,
      middleware: [middleware],
    });

    await llm.call(call);

    expect(seen).toEqual([{}]);
  });

  it('returns nothing when the span is not valid, as with the no-op tracer', async () => {
    const { seen, middleware } = reader();
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([textResponse('ok')]).client,
      middleware: [otelMiddleware({ tracer: trace.getTracer('noop'), metrics: false }), middleware],
    });

    await llm.call(call);

    expect(seen).toEqual([{}]);
  });

  it('gives each call its own ids', async () => {
    const { seen, middleware } = reader();
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([textResponse('ok')]).client,
      middleware: [otelMiddleware({ tracer: harness.tracer, metrics: false }), middleware],
    });

    await Promise.all([llm.call(call), llm.call(call)]);

    expect(new Set(seen.map((fields) => fields.spanId)).size).toBe(2);
  });
});

describe('endAttributes', () => {
  let harness: TraceHarness;

  beforeEach(() => {
    harness = createTraceHarness();
  });
  afterEach(async () => {
    await harness.shutdown();
  });

  const callSpan = () => harness.spans().find((span) => span.name === 'vernllm.call')!;
  const make = (options: Parameters<typeof otelMiddleware>[0], streaming = false) =>
    new VernLLM({
      ...BASE,
      client: streaming
        ? createMockStreamingClient([[{ type: 'text-delta', delta: 'hello' }]]).client
        : createMockClient([textResponse('ok')]).client,
      middleware: [otelMiddleware({ tracer: harness.tracer, metrics: false, ...options })],
    });

  it('puts a value known only at the end on the call span', async () => {
    let seenAtStart = false;
    const llm = make({
      attributes: () => ({ 'app.phase': 'start' }),
      endAttributes: () => {
        seenAtStart = true;
        return { 'vernllm.cost.estimated_usd': 0.0123, 'app.phase': 'end' };
      },
    });

    await llm.call(call);

    expect(seenAtStart).toBe(true);
    expect(callSpan().attributes).toMatchObject({
      'vernllm.cost.estimated_usd': 0.0123,
      'app.phase': 'end',
    });
  });

  it("lands on a stream's call span after finalResult settles, not before", async () => {
    let runs = 0;
    const llm = make(
      {
        endAttributes: () => {
          runs++;
          return { 'app.done': true };
        },
      },
      true,
    );

    const stream = await llm.call({ ...call, stream: true as const });
    expect(runs).toBe(0);

    await stream.finalResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runs).toBe(1);
    expect(callSpan().attributes['app.done']).toBe(true);
    expect(callSpan().attributes['vernllm.streaming']).toBe(true);
  });

  it('can never replace an attribute this package sets', async () => {
    const llm = make({
      endAttributes: () => ({
        'vernllm.answered.provider': 'hacked',
        'vernllm.total_attempts': 99,
        'vernllm.streaming': 'hacked',
        'vernllm.request_id': 'hacked',
        'gen_ai.request.stream': 'hacked',
      }),
    });
    const stream = await make(
      { endAttributes: () => ({ 'gen_ai.request.stream': 'hacked', 'vernllm.streaming': 'x' }) },
      true,
    ).call({ ...call, stream: true as const });
    await stream.finalResult;
    await llm.call(call);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const [streamed, plain] = harness.spans().filter((span) => span.name === 'vernllm.call');

    expect(plain!.attributes['vernllm.answered.provider']).not.toBe('hacked');
    expect(plain!.attributes['vernllm.total_attempts']).toBe(1);
    expect(plain!.attributes['vernllm.streaming']).not.toBe('hacked');
    expect(plain!.attributes['vernllm.request_id']).not.toBe('hacked');
    expect(streamed!.attributes['gen_ai.request.stream']).toBe(true);
    expect(streamed!.attributes['vernllm.streaming']).toBe(true);
  });

  it('drops values OpenTelemetry cannot carry, and survives a throwing function', async () => {
    const llm = make({
      endAttributes: () => ({ ok: 'yes', nested: { a: 1 } as never, nan: Number.NaN }),
    });
    await llm.call(call);

    expect(callSpan().attributes).toMatchObject({ ok: 'yes' });
    expect(callSpan().attributes).not.toHaveProperty('nested');
    expect(callSpan().attributes).not.toHaveProperty('nan');

    const throwing = make({
      endAttributes: () => {
        throw new Error('boom');
      },
    });
    await expect(throwing.call(call)).resolves.toBe('ok');
  });

  it('is applied for a failed call too', async () => {
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([new Error('down')]).client,
      middleware: [
        otelMiddleware({
          tracer: harness.tracer,
          metrics: false,
          endAttributes: () => ({ 'app.seen': true }),
        }),
      ],
    });

    await llm.call(call).catch(() => {});

    expect(callSpan().attributes['app.seen']).toBe(true);
  });

  it('rejects a non function at construction', () => {
    expect(() => otelMiddleware({ endAttributes: 'x' as never })).toThrow(/endAttributes/);
  });
});
