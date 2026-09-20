import { VernLLM } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  byStart,
  createMetricHarness,
  createMockClient,
  createTraceHarness,
  FakeApiError,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

import type { OtelMiddlewareOptions } from '../../src/types/index.js';
import type { Tracer } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

const BASE = { model: 'gpt-4o', maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const call = { userContent: 'hi', jsonMode: false as const };
const secretFailure = () => new FakeApiError('provider said: my secret prompt text', 500);

describe('exception recording', () => {
  let trace: TraceHarness;
  let meter: MetricHarness;

  beforeEach(() => {
    trace = createTraceHarness();
    meter = createMetricHarness();
  });

  afterEach(async () => {
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  const otel = (options: OtelMiddlewareOptions = {}, tracer: Tracer = trace.tracer) =>
    otelMiddleware({ tracer, meter: meter.meter, logger: 'silent', ...options });

  const spans = () => byStart(trace.spans());
  const exceptionsOf = (span: ReadableSpan) =>
    span.events.filter((event) => event.name === 'exception');

  /** Two targets that both fail, one retry each, so several attempts fail before the call does. */
  async function failingCall(options: OtelMiddlewareOptions) {
    const llm = new VernLLM({
      ...BASE,
      maxRetries: 1,
      client: createMockClient([secretFailure()]).client,
      fallback: { client: createMockClient([secretFailure()]).client, model: 'claude-x' },
      middleware: [otel(options)],
    });

    await expect(llm.call(call)).rejects.toThrow();
  }

  it('is off by default', async () => {
    await failingCall({});

    for (const span of spans()) expect(exceptionsOf(span)).toEqual([]);
  });

  it('records one exception event on the call span and on every failed attempt span', async () => {
    await failingCall({ recordExceptions: true });

    const all = spans();
    const callSpan = all.find((span) => span.name === 'vernllm.call')!;
    const attempts = all.filter((span) => span.name.startsWith('chat '));

    expect(attempts).toHaveLength(4);
    expect(exceptionsOf(callSpan)).toHaveLength(1);
    expect(exceptionsOf(callSpan)[0]!.attributes).toEqual({
      'exception.type': 'LLMError',
      'exception.message': 'fallback_exhausted',
    });

    for (const attempt of attempts) {
      expect(exceptionsOf(attempt), attempt.name).toHaveLength(1);
      expect(exceptionsOf(attempt)[0]!.attributes).toEqual({
        'exception.type': 'LLMError',
        'exception.message': 'server_error',
      });
    }
  });

  it("never records the provider's message, which can echo the prompt", async () => {
    await failingCall({ recordExceptions: { stack: false } });

    const serialized = JSON.stringify(spans().flatMap((span) => span.events));
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('stacktrace');
  });

  it('adds the stack trace only when asked for', async () => {
    await failingCall({ recordExceptions: { stack: true } });

    const callSpan = spans().find((span) => span.name === 'vernllm.call')!;
    const stack = exceptionsOf(callSpan)[0]!.attributes?.['exception.stacktrace'];

    expect(typeof stack).toBe('string');
    expect(String(stack).length).toBeGreaterThan(0);
  });

  it('records nothing for a call that succeeds', async () => {
    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([textResponse('ok')]).client,
      middleware: [otel({ recordExceptions: true })],
    });

    await llm.call(call);

    for (const span of spans()) expect(exceptionsOf(span)).toEqual([]);
  });

  it('records the error of an attempt that later retried successfully, but not the call', async () => {
    const llm = new VernLLM({
      ...BASE,
      maxRetries: 1,
      client: createMockClient([secretFailure(), textResponse('ok')]).client,
      middleware: [otel({ recordExceptions: true })],
    });

    await llm.call(call);

    const [callSpan, first, second] = spans();
    expect(exceptionsOf(callSpan!)).toEqual([]);
    expect(exceptionsOf(first!)).toHaveLength(1);
    expect(exceptionsOf(second!)).toEqual([]);
  });

  it('still records with GenAI conventions off, since exception events are not gen_ai ones', async () => {
    await failingCall({ recordExceptions: true, genAiConventions: false });

    const callSpan = spans().find((span) => span.name === 'vernllm.call')!;
    expect(exceptionsOf(callSpan)).toHaveLength(1);
  });

  it('cannot change a call, or leave a span open, when recording throws', async () => {
    const throwingRecord = (real: Tracer): Tracer =>
      ({
        startSpan: (...args: Parameters<Tracer['startSpan']>) => {
          const span = real.startSpan(...args);
          return new Proxy(span, {
            get(target, property) {
              const value = Reflect.get(target, property) as unknown;
              if (property === 'recordException') {
                return () => {
                  throw new Error('recordException broke');
                };
              }
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      }) as unknown as Tracer;

    const llm = new VernLLM({
      ...BASE,
      client: createMockClient([secretFailure()]).client,
      middleware: [otel({ recordExceptions: true }, throwingRecord(trace.tracer))],
    });

    await expect(llm.call(call)).rejects.toThrow();

    expect(trace.openSpans()).toEqual([]);
    // The status is set before the exception is recorded, so it survives the failure.
    for (const span of spans()) expect(span.status.code).toBe(2);
  });
});
