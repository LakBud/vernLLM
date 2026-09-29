import { SpanStatusCode, trace as otelTrace, type Tracer } from '@opentelemetry/api';
import {
  LLMError,
  type AttemptContext,
  type JsonValue,
  type PreDispatchContext,
  type VernLLMEvent,
  type WireCallRequest,
} from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { createMetrics } from '../../../../src/internal/metrics/metrics.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { CallTracker } from '../../../../src/internal/tracker/callTracker.js';
import { handleEvent } from '../../../../src/internal/tracker/handleEvent.utils.js';
import {
  byStart,
  createMetricHarness,
  createTraceHarness,
  pointsOf,
  type MetricHarness,
  type TraceHarness,
} from '../../../helpers.js';

import type { OtelMiddlewareOptions, TrackerDeps } from '../../../../src/types/index.js';

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
    it('ignores a usage report that arrives before any attempt', () => {
      const { start, errors } = setup();
      const tracker = start();

      expect(() => tracker.applyEvent(usage())).not.toThrow();

      tracker.startAttempt(attemptCtx(), request);
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
      expect(errors).not.toHaveBeenCalled();
    });
  });

  describe('custom events', () => {
    const custom = (data?: JsonValue): VernLLMEvent => ({
      kind: 'custom',
      requestId: 'r1',
      name: 'router.decision',
      source: 'router',
      ...(data === undefined ? {} : { data }),
    });

    const callSpanEvents = () => spans().find((span) => span.name === 'vernllm.call')!.events;

    it('adds a span event to the call span, named after the event, with its source only by default', () => {
      const { start } = setup();
      const tracker = start();

      tracker.applyEvent(custom({ deployment: 'claude' }));
      tracker.finish({ kind: 'error', error: new Error('x') });

      const events = callSpanEvents();
      expect(events.map((event) => event.name)).toEqual(['router.decision']);
      expect(events[0]!.attributes).toEqual({ 'vernllm.event.source': 'router' });
    });

    it('adds the data as JSON when customEvents.data is on', () => {
      const { start } = setup({ customEvents: { data: true } });
      const tracker = start();

      tracker.applyEvent(custom({ deployment: 'claude' }));
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(callSpanEvents()[0]!.attributes).toEqual({
        'vernllm.event.source': 'router',
        'vernllm.event.data': '{"deployment":"claude"}',
      });
    });

    it('cuts data to customEvents.maxLength', () => {
      const { start } = setup({ customEvents: { data: true, maxLength: 40 } });
      const tracker = start();

      tracker.applyEvent(custom({ text: 'x'.repeat(200) }));
      tracker.finish({ kind: 'error', error: new Error('x') });

      const data = callSpanEvents()[0]!.attributes?.['vernllm.event.data'] as string;
      expect(data.length).toBeLessThanOrEqual(40);
      expect(data.endsWith('…[truncated]')).toBe(true);
    });

    it('adds nothing when customEvents is false', () => {
      const { start } = setup({ customEvents: false });
      const tracker = start();

      tracker.applyEvent(custom({ deployment: 'claude' }));
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(callSpanEvents()).toEqual([]);
    });

    it('does not depend on middlewareEvents, which only covers the core middleware event', () => {
      const { start } = setup({ middlewareEvents: false });
      const tracker = start();

      tracker.applyEvent(custom());
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(callSpanEvents().map((event) => event.name)).toEqual(['router.decision']);
    });

    it('leaves the ended span alone when a late custom event arrives', () => {
      const { start } = setup();
      const tracker = start();

      tracker.finish({ kind: 'error', error: new Error('x') });
      tracker.applyEvent(custom());

      expect(callSpanEvents()).toEqual([]);
    });

    it('leaves the attempt untouched, since a custom event is not an attempt signal', () => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent(custom());
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.events).toEqual([]);
    });
  });

  describe('cache token attributes', () => {
    const cachedUsage = (): VernLLMEvent => ({
      kind: 'usage',
      requestId: 'r1',
      usage: {
        promptTokens: 100,
        completionTokens: 4,
        totalTokens: 104,
        cacheReadTokens: 60,
        cacheWriteTokens: 30,
        requestId: 'r1',
        model: 'gpt-4o',
      },
    });

    it('sets both cache attributes on the attempt that spent the tokens', () => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent(cachedUsage());
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes).toMatchObject({
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.cache_read.input_tokens': 60,
        'gen_ai.usage.cache_write.input_tokens': 30,
      });
    });

    it('sets them on a failed usage too, with the failure marked', () => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent({
        ...(cachedUsage() as Extract<VernLLMEvent, { kind: 'usage' }>),
        kind: 'usage_failure',
        error: new LLMError('bad', 'api', { code: 'server_error' }),
      });
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes).toMatchObject({
        'gen_ai.usage.cache_read.input_tokens': 60,
        'vernllm.usage.failed': true,
      });
    });

    it('sets none of them without cache counts, so a provider that reports none stays clean', () => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent(usage());
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes).not.toHaveProperty('gen_ai.usage.cache_read.input_tokens');
      expect(attempt.attributes).not.toHaveProperty('gen_ai.usage.cache_write.input_tokens');
    });

    it('sets none of them with GenAI conventions off', () => {
      const { start } = setup({ genAiConventions: false });
      const tracker = start();

      tracker.startAttempt(attemptCtx(), request);
      tracker.applyEvent(cachedUsage());
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'vernllm.attempt')!;
      expect(attempt.attributes).not.toHaveProperty('gen_ai.usage.cache_read.input_tokens');
    });
  });

  // The core waits for capacity before it dispatches, so a wait always arrives ahead of the
  // attempt it belongs to.
  describe('rate limit waits', () => {
    const waitOf = () =>
      spans().find((span) => span.name === 'chat gpt-4o')!.attributes['vernllm.rate_limit.wait_ms'];

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('ignores a wait of %s', (waited) => {
      const { start } = setup();
      const tracker = start();

      tracker.applyEvent(rateLimited(waited));
      tracker.startAttempt(attemptCtx(), request);
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(waitOf()).toBeUndefined();
    });

    it('adds up several waits and puts them on the next attempt', () => {
      const { start } = setup();
      const tracker = start();

      tracker.applyEvent(rateLimited(25));
      tracker.applyEvent(rateLimited(10));
      tracker.startAttempt(attemptCtx(), request);
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(waitOf()).toBe(35);
    });

    it('gives each wait to one attempt only', () => {
      const { start } = setup();
      const tracker = start();

      tracker.applyEvent(rateLimited(25));
      tracker.startAttempt(attemptCtx({ attempt: 1 }), request);
      tracker.applyEvent(retry());
      tracker.startAttempt(attemptCtx({ attempt: 2 }), request);
      tracker.finish({ kind: 'error', error: new Error('x') });

      const [first, second] = spans().filter((span) => span.name === 'chat gpt-4o');
      expect(first!.attributes['vernllm.rate_limit.wait_ms']).toBe(25);
      expect(second!.attributes).not.toHaveProperty('vernllm.rate_limit.wait_ms');
    });

    it('drops a wait whose attempt was never dispatched', () => {
      const { start } = setup();
      const tracker = start();

      tracker.applyEvent(rateLimited(25));
      tracker.applyEvent(retry());
      tracker.startAttempt(attemptCtx({ attempt: 2 }), request);
      tracker.finish({ kind: 'error', error: new Error('x') });

      expect(waitOf()).toBeUndefined();
    });
  });

  describe('a signal that never came', () => {
    it('closes an attempt with an unknown outcome when the next one starts without it', () => {
      const { start } = setup();
      const tracker = start();

      tracker.startAttempt(attemptCtx({ attempt: 1 }), request);
      tracker.startAttempt(attemptCtx({ attempt: 2 }), request);
      tracker.finish({ kind: 'result', result: { value: 'ok', meta: undefined } });

      const [, first, second] = spans();
      // Neither a success nor an error: nothing said how it ended.
      expect(first!.status.code).toBe(SpanStatusCode.UNSET);
      expect(first!.attributes['vernllm.attempt.outcome']).toBe('unknown');
      expect(first!.attributes['error.type']).toBeUndefined();
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
      handleEvent(usage(), undefined, tracker, deps.metrics);
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

  describe('dispatch', () => {
    const localRejection = () =>
      new LLMError('rejects forced tool choice', 'invalid_params', {
        code: 'unsupported_capability',
      });

    it('runs the request inside the attempt span and settles it with the outcome', async () => {
      const { start } = setup();
      const tracker = start();

      await expect(
        tracker.dispatch(attemptCtx(), request, async () => {
          throw new LLMError('down', 'api', { code: 'server_error', status: 503 });
        }),
      ).rejects.toMatchObject({ code: 'server_error' });
      // The retry that follows finds the attempt already closed and ends nothing twice.
      tracker.applyEvent(retry());
      tracker.finish({ kind: 'error', error: new Error('x') });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.status.code).toBe(SpanStatusCode.ERROR);
      expect(attempt.attributes['http.response.status_code']).toBe(503);
      const [point] = pointsOf((await meter.collect()).get('gen_ai.client.operation.duration'));
      expect((point!.value as { count: number }).count).toBe(1);
    });

    it('keeps a locally rejected attempt once something already started its span', async () => {
      const { start } = setup();
      const tracker = start();

      await expect(
        tracker.dispatch(attemptCtx(), request, async () => {
          // Stands in for an instrumentation reading its parent during the request.
          otelTrace.getSpan(tracker.measurementContext())?.spanContext();
          throw localRejection();
        }),
      ).rejects.toMatchObject({ code: 'unsupported_capability' });
      tracker.finish({ kind: 'error', error: localRejection() });

      expect(spans().map((span) => span.name)).toContain('chat gpt-4o');
      expect(spans()[0]!.attributes['vernllm.total_attempts']).toBe(1);
    });

    it('counts only the attempts that reached the provider', async () => {
      const { start } = setup();
      const tracker = start();

      await expect(
        tracker.dispatch(attemptCtx(), request, async () => {
          throw localRejection();
        }),
      ).rejects.toBeInstanceOf(LLMError);
      await tracker.dispatch(
        attemptCtx({ requestedProvider: 'fallback[0]' }),
        request,
        async () => {},
      );
      tracker.finish({ kind: 'result', result: { value: 'ok', meta: undefined } });

      expect(spans().filter((span) => span.name === 'chat gpt-4o')).toHaveLength(1);
      expect(spans()[0]!.attributes['vernllm.total_attempts']).toBe(1);
    });

    it('treats a rejection with a status as a real failure, whatever its code', async () => {
      const { start } = setup();
      const tracker = start();
      const withStatus = new LLMError('rejected upstream', 'invalid_params', {
        code: 'unsupported_capability',
        status: 400,
      });

      await expect(
        tracker.dispatch(attemptCtx(), request, async () => {
          throw withStatus;
        }),
      ).rejects.toBe(withStatus);
      tracker.finish({ kind: 'error', error: withStatus });

      expect(spans().find((span) => span.name === 'chat gpt-4o')!.status.code).toBe(
        SpanStatusCode.ERROR,
      );
    });

    it('just sends the request once the call has ended', async () => {
      const { start } = setup();
      const tracker = start();
      tracker.finish({ kind: 'error', error: new Error('ended') });
      const next = vi.fn(async () => {});

      await tracker.dispatch(attemptCtx(), request, next);

      expect(next).toHaveBeenCalledOnce();
      expect(spans().map((span) => span.name)).toEqual(['vernllm.call']);
    });

    it('leaves an attempt alone when the call ended while its request was out', async () => {
      const { start } = setup();
      const tracker = start();

      await tracker.dispatch(attemptCtx(), request, async () => {
        tracker.finish({ kind: 'error', error: new LLMError('aborted', 'aborted') });
      });

      const attempt = spans().find((span) => span.name === 'chat gpt-4o')!;
      expect(attempt.attributes['error.type']).toBe('aborted');
      expect(trace.openSpans()).toEqual([]);
    });
  });
});
