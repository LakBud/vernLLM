import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import {
  LLMError,
  type AttemptContext,
  type PreDispatchContext,
  type VernLLMEvent,
  type WireCallRequest,
} from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../src/guard.js';
import { createMetrics } from '../../src/metrics.js';
import { normalizeOptions, type OtelMiddlewareOptions } from '../../src/options.js';
import { CallTracker, handleEvent, type TrackerDeps } from '../../src/tracker.js';
import {
  byStart,
  createMetricHarness,
  createTraceHarness,
  pointsOf,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

// The tracker is normally driven by the core, which only ever calls it in a sensible order.
// These tests call it directly in the orders the core does not, so every guard is exercised.

const callCtx = {
  requestId: 'r1',
  primaryProvider: 'primary',
  primaryModel: 'gpt-4o',
} as PreDispatchContext;
const request: WireCallRequest = {
  model: 'gpt-4o',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
};
const attemptCtx = (overrides: Partial<AttemptContext> = {}) =>
  ({
    requestedProvider: 'primary',
    requestedModel: 'gpt-4o',
    isFallbackAttempt: false,
    attempt: 1,
    ...overrides,
  }) as AttemptContext;

const usage = (): VernLLMEvent => ({
  kind: 'usage',
  requestId: 'r1',
  usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, requestId: 'r1', model: 'gpt-4o' },
});

const rateLimited = (waitedMs: number): VernLLMEvent => ({
  kind: 'rate_limited',
  requestId: 'r1',
  provider: 'primary',
  model: 'gpt-4o',
  waitedMs,
  reason: 'rpm',
});

const retry = (): VernLLMEvent => ({
  kind: 'retry',
  requestId: 'r1',
  provider: 'primary',
  model: 'gpt-4o',
  attempt: 1,
  maxRetries: 2,
  delayMs: 5,
  retryAfterHonored: false,
  error: new LLMError('down', 'api', { code: 'server_error' }),
});

describe('CallTracker driven directly', () => {
  let trace: TraceHarness;
  let meter: MetricHarness;

  afterEach(async () => {
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  function setup(options: OtelMiddlewareOptions = {}, tracerOverride?: (real: Tracer) => Tracer) {
    trace = createTraceHarness();
    meter = createMetricHarness();

    const errors = vi.fn();
    const config = normalizeOptions({ meter: meter.meter, ...options });
    const guard = createGuard({ debug: () => {}, warn: () => {}, error: errors });
    const tracer = tracerOverride ? tracerOverride(trace.tracer) : trace.tracer;
    const deps: TrackerDeps = {
      config,
      guard,
      metrics: createMetrics(config, guard),
      getTracer: () => tracer,
    };

    return { deps, errors, start: () => CallTracker.start(deps, callCtx, request) };
  }

  const spans = () => byStart(trace.spans());

  describe('once the call has ended', () => {
    it('starts no further attempt', () => {
      const { start } = setup();
      const tracker = start();

      tracker.finish({ kind: 'error', error: new Error('failed') });
      tracker.startAttempt(attemptCtx(), request);

      expect(spans().map((span) => span.name)).toEqual(['vernllm.call']);
      expect(trace.openSpans()).toEqual([]);
    });

    it('leaves the ended span alone when a late event arrives', () => {
      const { start } = setup();
      const tracker = start();

      tracker.finish({ kind: 'error', error: new Error('failed') });
      tracker.applyEvent(retry());
      tracker.applyEvent({
        kind: 'middleware',
        requestId: 'r1',
        middleware: 'late',
        hook: 'wrap_short_circuit',
      });

      expect(spans()[0]!.events).toEqual([]);
      expect(spans()[0]!.attributes).not.toHaveProperty('vernllm.short_circuit.by');
    });

    it('does nothing on a second finish', async () => {
      const { start } = setup();
      const tracker = start();

      tracker.finish({ kind: 'error', error: new Error('first') });
      tracker.finish({ kind: 'error', error: new LLMError('second', 'timeout') });

      expect(spans()).toHaveLength(1);
      expect(spans()[0]!.attributes['error.type']).toBe('_OTHER');

      // One measurement, not two: the second finish never reached the metrics.
      const points = pointsOf((await meter.collect()).get('vernllm.call.duration'));
      expect(points).toHaveLength(1);
      expect((points[0]!.value as { count: number }).count).toBe(1);
    });
  });

  describe('events with no open attempt', () => {
    it('ignores a rate limit wait, and a usage report, that arrive before any attempt', () => {
      const { start, errors } = setup();
      const tracker = start();

      expect(() => {
        tracker.applyEvent(rateLimited(50));
        tracker.applyEvent(usage());
      }).not.toThrow();

      tracker.startAttempt(attemptCtx(), request);
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes).not.toHaveProperty('vernllm.rate_limit.wait_ms');
      expect(attempt.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
      expect(errors).not.toHaveBeenCalled();
    });
  });

  describe('rate limit waits', () => {
    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('ignores a wait of %s', (waited) => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent(rateLimited(waited));
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(spans().find((span) => span.name === 'chat gpt-4o')!.attributes).not.toHaveProperty(
        'vernllm.rate_limit.wait_ms',
      );
    });

    it('adds up several waits on one attempt', () => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent(rateLimited(25));
      tracker.applyEvent(rateLimited(10));
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(
        spans().find((span) => span.name === 'chat gpt-4o')!.attributes[
          'vernllm.rate_limit.wait_ms'
        ],
      ).toBe(35);
    });
  });

  describe('a signal that never came', () => {
    it('closes an attempt as a failure when the next one starts without it', () => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx({ attempt: 1 }), request);
      tracker.startAttempt(attemptCtx({ attempt: 2 }), request);
      tracker.finish({ kind: 'result', result: { value: 'ok', meta: undefined } });

      const [, first, second] = spans();
      expect(first!.status.code).toBe(SpanStatusCode.ERROR);
      expect(first!.attributes['error.type']).toBe('_OTHER');
      expect(second!.status.code).toBe(SpanStatusCode.OK);
      expect(trace.openSpans()).toEqual([]);
    });
  });

  describe('an attempt span that could not be created', () => {
    // Calls stay observable through metrics even when only the attempt span is unavailable.
    const noAttemptSpans = (real: Tracer): Tracer =>
      ({
        startSpan: (...args: Parameters<Tracer['startSpan']>) => {
          if (args[0].startsWith('chat ')) throw new Error('no attempt spans today');
          return real.startSpan(...args);
        },
      }) as unknown as Tracer;

    it('still records the attempt duration and ends the call cleanly', async () => {
      const { deps, start, errors } = setup({}, noAttemptSpans);
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      handleEvent(usage(), tracker, deps.metrics);
      tracker.finish({ kind: 'result', result: { value: 'ok', meta: undefined } });

      expect(spans().map((span) => span.name)).toEqual(['vernllm.call']);
      expect(errors).toHaveBeenCalledWith(
        '[VernLLM] otel: startAttemptSpan failed',
        expect.objectContaining({ message: 'no attempt spans today' }),
      );

      const collected = await meter.collect();
      expect(pointsOf(collected.get('gen_ai.client.operation.duration'))).toHaveLength(1);
      expect(pointsOf(collected.get('gen_ai.client.token.usage'))).toHaveLength(2);
      expect(trace.openSpans()).toEqual([]);
    });

    it('records a failed attempt the same way', async () => {
      const { start } = setup({}, noAttemptSpans);
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent(retry());
      tracker.finish({
        kind: 'error',
        error: new LLMError('down', 'api', { code: 'server_error' }),
      });

      const [point] = pointsOf((await meter.collect()).get('gen_ai.client.operation.duration'));
      expect(point!.attributes['error.type']).toBe('server_error');
    });
  });
});
