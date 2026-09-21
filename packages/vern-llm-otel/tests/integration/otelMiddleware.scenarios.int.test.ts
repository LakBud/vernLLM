import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { LLMError, VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  byStart,
  createMetricHarness,
  createMockClient,
  createMockStreamingClient,
  createTraceHarness,
  describeOutcome,
  FakeApiError,
  parentIdOf,
  pointsOf,
  settleOutcome,
  sleep,
  spanId,
  textResponse,
  type Outcome,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

import type { MetricData } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

// One data table and one runner. Every row runs twice, with and without the middleware, and
// the caller must not be able to tell the difference. Only then are spans and metrics checked.

const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const ok = (text = 'ok') => textResponse(text, USAGE);
const serverError = () => new FakeApiError('provider said: secret prompt text', 500);

const BASE = { model: 'gpt-4o', maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const PROVIDER_NAMES = { primary: 'openai', 'fallback[0]': 'anthropic' };

interface SpanExpectation {
  name: string;
  /** Index of the parent in this list, `null` for a root. */
  parent: number | null;
  status: 'OK' | 'ERROR';
  kind?: SpanKind;
  attrs?: Record<string, unknown>;
  absent?: string[];
  events?: string[];
}

interface Observed {
  outcome: Outcome;
  spans: ReadableSpan[];
  metrics: Map<string, MetricData>;
  errorLogs: number;
}

interface Scenario {
  name: string;
  /** Builds a fresh instance. `otel` is empty for the baseline run. */
  build(otel: VernLLMMiddleware[]): { execute(): Promise<unknown> };
  spans?: SpanExpectation[];
  /** Exact set of metrics expected, with each one's total (histogram count or counter sum). */
  metrics: Record<string, number>;
  check?: (observed: Observed) => void;
}

const totalOf = (metric: MetricData | undefined): number =>
  pointsOf(metric).reduce(
    (sum, point) => sum + (typeof point.value === 'number' ? point.value : point.value.count),
    0,
  );

const primaryAndFallback = (
  primary: Parameters<typeof createMockClient>[0],
  fallback: Parameters<typeof createMockClient>[0],
) => ({
  client: createMockClient(primary).client,
  fallback: { client: createMockClient(fallback).client, model: 'claude-x' },
});

const call = { userContent: 'hi', jsonMode: false as const };
const cachedParams = { cacheKey: 'k', ttl: 10_000, call };

const scenarios: Scenario[] = [
  {
    name: 'success',
    build: (otel) => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([ok()]).client,
        middleware: otel,
      });
      return { execute: () => llm.call(call) };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        kind: SpanKind.INTERNAL,
        attrs: {
          'vernllm.primary.provider': 'primary',
          'vernllm.primary.model': 'gpt-4o',
          'vernllm.answered.provider': 'primary',
          'vernllm.used_fallback': false,
          'vernllm.total_attempts': 1,
          'vernllm.streaming': false,
        },
        absent: ['vernllm.no_attempt.reason', 'error.type', 'gen_ai.operation.name'],
      },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'OK',
        kind: SpanKind.CLIENT,
        attrs: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'openai',
          'gen_ai.request.model': 'gpt-4o',
          'gen_ai.output.type': 'text',
          'gen_ai.usage.input_tokens': 3,
          'gen_ai.usage.output_tokens': 4,
          'vernllm.target': 'primary',
          'vernllm.attempt': 1,
          'vernllm.is_fallback': false,
        },
        absent: ['error.type', 'gen_ai.request.stream'],
      },
    ],
    metrics: {
      'gen_ai.client.token.usage': 2,
      'gen_ai.client.operation.duration': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'retry then success',
    build: (otel) => {
      const client = createMockClient([serverError(), ok()]).client;
      const llm = new VernLLM({ ...BASE, maxRetries: 2, client, middleware: otel });
      return { execute: () => llm.call(call) };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        attrs: { 'vernllm.total_attempts': 2 },
        events: ['vernllm.retry'],
      },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'ERROR',
        attrs: {
          'vernllm.attempt': 1,
          'error.type': 'server_error',
          'http.response.status_code': 500,
        },
        absent: ['gen_ai.usage.input_tokens'],
      },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'OK',
        attrs: { 'vernllm.attempt': 2, 'gen_ai.usage.input_tokens': 3 },
        absent: ['error.type'],
      },
    ],
    metrics: {
      'gen_ai.client.token.usage': 2,
      'gen_ai.client.operation.duration': 2,
      'vernllm.retry.count': 1,
      'vernllm.retry.delay': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'retries exhausted, then a fallback answers',
    build: (otel) => {
      const { client, fallback } = primaryAndFallback([serverError()], [ok()]);
      const llm = new VernLLM({ ...BASE, maxRetries: 1, client, fallback, middleware: otel });
      return { execute: () => llm.call(call) };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        attrs: {
          'vernllm.used_fallback': true,
          'vernllm.answered.provider': 'fallback[0]',
          'vernllm.answered.model': 'claude-x',
          'vernllm.total_attempts': 3,
        },
        events: ['vernllm.retry', 'vernllm.fallback'],
      },
      { name: 'chat gpt-4o', parent: 0, status: 'ERROR', attrs: { 'vernllm.attempt': 1 } },
      { name: 'chat gpt-4o', parent: 0, status: 'ERROR', attrs: { 'vernllm.attempt': 2 } },
      {
        name: 'chat claude-x',
        parent: 0,
        status: 'OK',
        attrs: {
          'gen_ai.provider.name': 'anthropic',
          'vernllm.target': 'fallback[0]',
          'vernllm.is_fallback': true,
          'gen_ai.usage.output_tokens': 4,
        },
      },
    ],
    metrics: {
      'gen_ai.client.token.usage': 2,
      'gen_ai.client.operation.duration': 3,
      'vernllm.retry.count': 1,
      'vernllm.retry.delay': 1,
      'vernllm.fallback.count': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'every target fails',
    build: (otel) => {
      const { client, fallback } = primaryAndFallback([serverError()], [serverError()]);
      const llm = new VernLLM({ ...BASE, client, fallback, middleware: otel });
      return { execute: () => llm.call(call) };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'ERROR',
        attrs: {
          'error.type': 'fallback_exhausted',
          'vernllm.fallback.attempts': 2,
          'http.response.status_code': 500,
          'vernllm.total_attempts': 2,
        },
        absent: ['vernllm.no_attempt.reason'],
        events: ['vernllm.fallback'],
      },
      { name: 'chat gpt-4o', parent: 0, status: 'ERROR', attrs: { 'error.type': 'server_error' } },
      {
        name: 'chat claude-x',
        parent: 0,
        status: 'ERROR',
        // The last attempt reports its own failure, not the summary error thrown afterwards.
        attrs: { 'error.type': 'server_error', 'http.response.status_code': 500 },
      },
    ],
    metrics: {
      'gen_ai.client.operation.duration': 2,
      'vernllm.fallback.count': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'terminal failure with no retry and no fallback',
    build: (otel) => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([serverError()]).client,
        middleware: otel,
      });
      return { execute: () => llm.call(call) };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'ERROR',
        attrs: { 'error.type': 'server_error', 'http.response.status_code': 500 },
      },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'ERROR',
        attrs: { 'error.type': 'server_error', 'http.response.status_code': 500 },
      },
    ],
    metrics: {
      'gen_ai.client.operation.duration': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'usage failure, then a retry',
    build: (otel) => {
      const client = createMockClient([ok('N/A'), ok('real answer')]).client;
      const llm = new VernLLM({
        ...BASE,
        maxRetries: 1,
        client,
        middleware: otel,
        detectSoftFailure: (result) =>
          typeof result === 'string' && result.trim() === 'N/A' ? 'empty_response' : undefined,
      });
      return { execute: () => llm.call(call) };
    },
    spans: [
      { name: 'vernllm.call', parent: null, status: 'OK', events: ['vernllm.retry'] },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'ERROR',
        attrs: {
          'vernllm.usage.failed': true,
          'gen_ai.usage.input_tokens': 3,
          'gen_ai.usage.output_tokens': 4,
          'error.type': 'empty_response',
        },
      },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'OK',
        attrs: { 'gen_ai.usage.input_tokens': 3 },
        absent: ['vernllm.usage.failed'],
      },
    ],
    metrics: {
      // Tokens spent on the failed attempt count as much as the ones spent on the good one.
      'gen_ai.client.token.usage': 4,
      'gen_ai.client.operation.duration': 2,
      'vernllm.usage_failure.count': 1,
      'vernllm.retry.count': 1,
      'vernllm.retry.delay': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'provider omitted usage',
    build: (otel) => {
      const client = createMockClient([textResponse('ok')]).client;
      const llm = new VernLLM({ ...BASE, client, middleware: otel });
      return { execute: () => llm.call(call) };
    },
    spans: [
      { name: 'vernllm.call', parent: null, status: 'OK' },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'OK',
        absent: ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'],
      },
    ],
    metrics: {
      'gen_ai.client.operation.duration': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'primary circuit open with a fallback',
    build: (otel) => {
      const { client, fallback } = primaryAndFallback([serverError()], [ok()]);
      const llm = new VernLLM({
        ...BASE,
        client,
        fallback,
        circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
        middleware: otel,
      });
      return { execute: async () => [await llm.call(call), await llm.call(call)] };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        events: ['vernllm.circuit_state', 'vernllm.fallback'],
      },
      { name: 'chat gpt-4o', parent: 0, status: 'ERROR' },
      { name: 'chat claude-x', parent: 0, status: 'OK' },
      // The second call never attempts the open primary, so the fallback event arrives with
      // no attempt open and must not end anything.
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        attrs: { 'vernllm.total_attempts': 1, 'vernllm.used_fallback': true },
        events: ['vernllm.fallback'],
      },
      { name: 'chat claude-x', parent: 3, status: 'OK' },
    ],
    metrics: {
      'gen_ai.client.token.usage': 4,
      'gen_ai.client.operation.duration': 3,
      'vernllm.fallback.count': 2,
      'vernllm.circuit.transitions': 1,
      'vernllm.call.duration': 2,
      'vernllm.call.attempts': 2,
    },
  },
  {
    name: 'rate limit wait',
    build: (otel) => {
      const slow = async () => {
        await sleep(80);
        return ok();
      };
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([slow]).client,
        rateLimit: { maxConcurrent: 1 },
        middleware: otel,
      });
      return { execute: () => Promise.all([llm.call(call), llm.call(call)]) };
    },
    metrics: {
      'gen_ai.client.token.usage': 4,
      'gen_ai.client.operation.duration': 2,
      'vernllm.rate_limit.wait': 1,
      'vernllm.call.duration': 2,
      'vernllm.call.attempts': 2,
    },
    check: ({ spans, metrics }) => {
      const attempts = spans.filter((span) => span.name === 'chat gpt-4o');
      const waited = attempts.filter((span) => 'vernllm.rate_limit.wait_ms' in span.attributes);

      expect(waited).toHaveLength(1);
      expect(Number(waited[0]!.attributes['vernllm.rate_limit.wait_ms'])).toBeGreaterThan(50);

      // Both attempts take about 80ms at the provider, and the second also waits about 80ms for
      // capacity. Its span covers the wait, but its duration metric leaves it out, so no
      // recorded duration comes near the 160ms a wait inclusive figure would show.
      const seconds = (span: ReadableSpan) => span.duration[0] + span.duration[1] / 1e9;
      const waitedSpanSeconds = seconds(waited[0]!);
      expect(waitedSpanSeconds).toBeGreaterThan(0.14);

      const [point] = pointsOf(metrics.get('gen_ai.client.operation.duration'));
      expect((point!.value as { max?: number }).max).toBeLessThan(waitedSpanSeconds - 0.025);
    },
  },
  {
    name: 'cache hit',
    build: (otel) => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([ok()]).client,
        middleware: otel,
      });
      return {
        execute: async () => [
          await llm.cachedCall(cachedParams),
          await llm.cachedCall(cachedParams),
        ],
      };
    },
    spans: [
      { name: 'vernllm.call', parent: null, status: 'OK', attrs: { 'vernllm.total_attempts': 1 } },
      { name: 'chat gpt-4o', parent: 0, status: 'OK' },
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        attrs: { 'vernllm.no_attempt.reason': 'cache_hit', 'vernllm.total_attempts': 0 },
        absent: ['vernllm.answered.provider'],
      },
    ],
    metrics: {
      'gen_ai.client.token.usage': 2,
      'gen_ai.client.operation.duration': 1,
      'vernllm.call.duration': 2,
      'vernllm.call.attempts': 2,
    },
  },
  {
    name: 'coalesced cachedCall joiner',
    build: (otel) => {
      const slow = async () => {
        await sleep(40);
        return ok();
      };
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([slow]).client,
        middleware: otel,
      });
      return {
        execute: () => Promise.all([llm.cachedCall(cachedParams), llm.cachedCall(cachedParams)]),
      };
    },
    metrics: {
      'gen_ai.client.token.usage': 2,
      'gen_ai.client.operation.duration': 1,
      'vernllm.call.duration': 2,
      'vernllm.call.attempts': 2,
    },
    check: ({ spans }) => {
      const calls = spans.filter((span) => span.name === 'vernllm.call');
      const attempts = spans.filter((span) => span.name === 'chat gpt-4o');
      const joiner = calls.filter(
        (span) => span.attributes['vernllm.no_attempt.reason'] === 'coalesced',
      );
      const leader = calls.filter((span) => span.attributes['vernllm.total_attempts'] === 1);

      expect(calls).toHaveLength(2);
      expect(attempts).toHaveLength(1);
      expect(joiner).toHaveLength(1);
      expect(leader).toHaveLength(1);

      // The joiner still reports who answered, from meta, but no usage is attributed to it.
      expect(joiner[0]!.attributes['vernllm.answered.provider']).toBe('primary');
      expect(joiner[0]!.status.code).toBe(SpanStatusCode.OK);
      expect(parentIdOf(attempts[0]!)).toBe(spanId(leader[0]!));
    },
  },
  {
    name: 'inner wrap short circuit',
    build: (otel) => {
      const { client } = createMockClient([ok()]);
      const guard: VernLLMMiddleware = { name: 'guard', wrap: async () => ({ value: 'short' }) };
      const llm = new VernLLM({ ...BASE, client, middleware: [guard, ...otel] });
      return { execute: () => llm.call(call) };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        attrs: {
          'vernllm.no_attempt.reason': 'short_circuit',
          'vernllm.short_circuit.by': 'guard',
          'vernllm.total_attempts': 0,
        },
      },
    ],
    metrics: { 'vernllm.call.duration': 1, 'vernllm.call.attempts': 1 },
  },
  {
    name: 'stream success',
    build: (otel) => {
      const { client } = createMockStreamingClient([
        [
          { type: 'text-delta', delta: 'hel' },
          { type: 'text-delta', delta: 'lo' },
          { type: 'usage', usage: USAGE },
        ],
      ]);
      const llm = new VernLLM({ ...BASE, client, middleware: otel });
      return {
        execute: async () => {
          const { chunks, finalResult } = await llm.call({ ...call, stream: true });
          const seen: unknown[] = [];
          for await (const chunk of chunks) seen.push(chunk);
          return { seen, final: await finalResult };
        },
      };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'OK',
        attrs: { 'vernllm.streaming': true, 'gen_ai.request.stream': true },
      },
      {
        name: 'chat gpt-4o',
        parent: 0,
        status: 'OK',
        attrs: {
          'gen_ai.request.stream': true,
          'gen_ai.usage.input_tokens': 3,
          'gen_ai.usage.output_tokens': 4,
        },
      },
    ],
    metrics: {
      'gen_ai.client.token.usage': 2,
      'gen_ai.client.operation.duration': 1,
      'gen_ai.client.operation.time_to_first_chunk': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'stream that fails mid way and is never read',
    build: (otel) => {
      const { client } = createMockStreamingClient([
        async function* () {
          yield { type: 'text-delta' as const, delta: 'partial' };
          throw serverError();
        },
      ]);
      const llm = new VernLLM({ ...BASE, client, middleware: otel });
      return {
        execute: async () => {
          await llm.call({ ...call, stream: true });
          await sleep(30);
          return 'left unread';
        },
      };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'ERROR',
        attrs: { 'vernllm.streaming': true },
      },
      { name: 'chat gpt-4o', parent: 0, status: 'ERROR' },
    ],
    metrics: {
      'gen_ai.client.operation.duration': 1,
      'gen_ai.client.operation.time_to_first_chunk': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'stream read by a slow consumer',
    build: (otel) => {
      const { client } = createMockStreamingClient([
        async function* () {
          await sleep(10);
          yield { type: 'text-delta' as const, delta: 'a' };
          yield { type: 'text-delta' as const, delta: 'b' };
          yield { type: 'usage' as const, usage: USAGE };
        },
      ]);
      const llm = new VernLLM({ ...BASE, client, middleware: otel });
      return {
        execute: async () => {
          const { chunks, finalResult } = await llm.call({ ...call, stream: true });
          await sleep(150);
          const seen: unknown[] = [];
          for await (const chunk of chunks) seen.push(chunk);
          return { seen, final: await finalResult };
        },
      };
    },
    metrics: {
      'gen_ai.client.token.usage': 2,
      'gen_ai.client.operation.duration': 1,
      'gen_ai.client.operation.time_to_first_chunk': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
    check: ({ metrics }) => {
      // Chunks are buffered and read at the consumer's pace, so what is measured is the
      // provider's first chunk, not when the slow consumer got round to reading it.
      const [point] = pointsOf(metrics.get('gen_ai.client.operation.time_to_first_chunk'));
      const histogram = point!.value as { max?: number };
      expect(histogram.max).toBeLessThan(0.1);
    },
  },
  {
    name: 'abort in the middle of a call',
    build: (otel) => {
      const hangs = (_params: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('client saw the abort')));
        });
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([hangs]).client,
        middleware: otel,
      });
      return {
        execute: () => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 15);
          return llm.call({ ...call, signal: controller.signal });
        },
      };
    },
    spans: [
      { name: 'vernllm.call', parent: null, status: 'ERROR' },
      { name: 'chat gpt-4o', parent: 0, status: 'ERROR' },
    ],
    metrics: {
      'gen_ai.client.operation.duration': 1,
      'vernllm.call.duration': 1,
      'vernllm.call.attempts': 1,
    },
  },
  {
    name: 'an earlier middleware transform throws before any attempt starts',
    build: (otel) => {
      const blocker: VernLLMMiddleware = {
        name: 'blocker',
        priority: -2000,
        transform: () => {
          throw new Error('bug in the blocker');
        },
      };
      const { client } = createMockClient([ok()]);
      const llm = new VernLLM({ ...BASE, client, middleware: [blocker, ...otel] });
      return { execute: () => llm.call(call) };
    },
    spans: [
      {
        name: 'vernllm.call',
        parent: null,
        status: 'ERROR',
        attrs: { 'error.type': 'middleware_threw', 'vernllm.total_attempts': 0 },
        absent: ['vernllm.no_attempt.reason'],
      },
    ],
    metrics: { 'vernllm.call.duration': 1, 'vernllm.call.attempts': 1 },
  },
];

describe('scenario matrix', () => {
  let trace: TraceHarness;
  let meter: MetricHarness;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    trace = createTraceHarness();
    meter = createMetricHarness();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  async function observe(scenario: Scenario, withOtel: boolean): Promise<Observed> {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const otel = withOtel
      ? [
          otelMiddleware({
            tracer: trace.tracer,
            meter: meter.meter,
            providerNames: PROVIDER_NAMES,
            logger,
          }),
        ]
      : [];

    const outcome = await settleOutcome(scenario.build(otel).execute());
    await sleep(5);

    return {
      outcome,
      spans: byStart(trace.spans()),
      metrics: await meter.collect(),
      errorLogs: logger.error.mock.calls.length,
    };
  }

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const baseline = await settleOutcome(scenario.build([]).execute());
      const observed = await observe(scenario, true);

      // The caller cannot tell the middleware is there.
      expect(describeOutcome(observed.outcome)).toEqual(describeOutcome(baseline));
      expect(observed.errorLogs).toBe(0);
      expect(unhandled).toEqual([]);

      const { spans } = observed;
      if (scenario.spans) {
        expect(spans.map((span) => span.name)).toEqual(scenario.spans.map((span) => span.name));

        scenario.spans.forEach((expected, index) => {
          const span = spans[index]!;
          const parent = expected.parent === null ? undefined : spanId(spans[expected.parent]!);

          expect(parentIdOf(span), `parent of span ${index}`).toBe(parent);
          expect(span.status.code, `status of span ${index}`).toBe(
            expected.status === 'OK' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          );
          if (expected.kind !== undefined) expect(span.kind).toBe(expected.kind);
          if (expected.attrs) expect(span.attributes).toMatchObject(expected.attrs);
          for (const key of expected.absent ?? []) expect(span.attributes).not.toHaveProperty(key);
          if (expected.events)
            expect(span.events.map((event) => event.name)).toEqual(expected.events);
        });
      }

      // No span was left open (an unended span never reaches the exporter), and a failed call reports the error the caller actually got.
      expect(spans.every((span) => span.ended)).toBe(true);
      expect(trace.openSpans()).toEqual([]);
      if (!observed.outcome.ok) {
        const error = observed.outcome.error as Partial<LLMError>;
        const callSpan = spans.find((span) => span.name === 'vernllm.call');
        expect(callSpan?.attributes['error.type']).toBe(error.code ?? error.type);
        expect(callSpan?.status.message).toBe(error.code ?? error.type);
        expect(callSpan?.status.message).not.toContain('secret');
      }

      const totals = Object.fromEntries(
        [...observed.metrics].map(([name, metric]) => [name, totalOf(metric)]),
      );
      expect(totals).toEqual(scenario.metrics);

      scenario.check?.(observed);
    },
  );
});
