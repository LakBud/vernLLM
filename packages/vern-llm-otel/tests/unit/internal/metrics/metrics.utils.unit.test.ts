import { context, createContextKey, metrics as metricsApi, type Meter } from '@opentelemetry/api';
import { LLMError, type TokenUsage, type VernLLMEvent } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { CATALOG, type MetricKey } from '../../../../src/internal/metrics/catalog.js';
import {
  createMetrics,
  NORMALIZED_MODEL_CACHE_LIMIT,
} from '../../../../src/internal/metrics/metrics.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import {
  createMetricHarness,
  histogramOf,
  pointsOf,
  type MetricHarness,
} from '../../../helpers.js';

import type { OtelMiddlewareOptions } from '../../../../src/types/index.js';

const harnesses: MetricHarness[] = [];

afterEach(async () => {
  metricsApi.disable();
  vi.restoreAllMocks();
  await Promise.all(harnesses.splice(0).map((harness) => harness.shutdown()));
});

function setup(options: OtelMiddlewareOptions = {}) {
  const harness = createMetricHarness();
  harnesses.push(harness);

  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = normalizeOptions({ meter: harness.meter, ...options });
  const metrics = createMetrics(config, createGuard(logger));

  return { harness, logger, metrics };
}

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  promptTokens: 12,
  completionTokens: 34,
  totalTokens: 46,
  requestId: 'req-secret-123',
  model: 'gpt-4o',
  provider: 'primary',
  ...overrides,
});

const apiError = new LLMError('the prompt said: secret', 'api', { code: 'server_error' });

describe('record', () => {
  it.each([
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '5',
    null,
    undefined,
  ])('ignores an unusable value (%s)', async (value) => {
    const { harness, metrics, logger } = setup();

    metrics.record('operationDuration', value as number, {});

    expect((await harness.collect()).size).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('records zero, which is a real measurement', async () => {
    const { harness, metrics } = setup();

    metrics.record('operationDuration', 0, { a: 'b' });
    const [point] = pointsOf((await harness.collect()).get('gen_ai.client.operation.duration'));

    expect(point?.attributes).toEqual({ a: 'b' });
    expect(histogramOf(point).count).toBe(1);
  });

  it('sums a counter across records with the same attributes', async () => {
    const { harness, metrics } = setup();

    metrics.record('retryCount', 1, { k: 'v' });
    metrics.record('retryCount', 1, { k: 'v' });
    const points = pointsOf((await harness.collect()).get('vernllm.retry.count'));

    expect(points).toEqual([{ attributes: { k: 'v' }, value: 2 }]);
  });

  it('creates an instrument lazily and only once', () => {
    const harness = createMetricHarness();
    harnesses.push(harness);
    const createHistogram = vi.spyOn(harness.meter, 'createHistogram');
    const metrics = createMetrics(
      normalizeOptions({ meter: harness.meter }),
      createGuard('silent'),
    );

    expect(createHistogram).not.toHaveBeenCalled();

    metrics.record('operationDuration', 1, {});
    metrics.record('operationDuration', 2, {});
    metrics.record('operationDuration', 3, {});

    expect(createHistogram).toHaveBeenCalledTimes(1);
  });

  it('passes the given context through, so exemplars link to the right span', () => {
    const record = vi.fn();
    const add = vi.fn();
    const meter = {
      createHistogram: () => ({ record }),
      createCounter: () => ({ add }),
    } as unknown as Meter;
    const metrics = createMetrics(normalizeOptions({ meter }), createGuard('silent'));
    const ctx = context.active().setValue(createContextKey('marker'), 1);

    metrics.record('operationDuration', 1.5, { a: 'b' }, ctx);
    metrics.record('retryCount', 1, { a: 'b' }, ctx);

    expect(record).toHaveBeenCalledWith(1.5, { a: 'b' }, ctx);
    expect(add).toHaveBeenCalledWith(1, { a: 'b' }, ctx);
  });

  it('uses the global meter when none was given, resolved at first use', async () => {
    const harness = createMetricHarness();
    harnesses.push(harness);
    const metrics = createMetrics(normalizeOptions({}), createGuard('silent'));

    // Registered after the middleware was built, the way an SDK started late would be.
    metricsApi.setGlobalMeterProvider(harness.provider);
    metrics.record('operationDuration', 1, {});

    expect((await harness.collect()).has('gen_ai.client.operation.duration')).toBe(true);
  });
});

describe('disabled modes', () => {
  it('metrics: false creates nothing and records nothing', async () => {
    const harness = createMetricHarness();
    harnesses.push(harness);
    const createHistogram = vi.spyOn(harness.meter, 'createHistogram');
    const createCounter = vi.spyOn(harness.meter, 'createCounter');
    const metrics = createMetrics(
      normalizeOptions({ meter: harness.meter, metrics: false }),
      createGuard('silent'),
    );

    for (const key of Object.keys(CATALOG) as MetricKey[]) metrics.record(key, 1, {});
    metrics.recordEvent({ kind: 'usage', requestId: 'r', usage: usage() });

    expect(createHistogram).not.toHaveBeenCalled();
    expect(createCounter).not.toHaveBeenCalled();
    expect((await harness.collect()).size).toBe(0);
  });

  it('genAiConventions: false skips the GenAI instruments and keeps the vernllm ones', async () => {
    const { harness, metrics } = setup({ genAiConventions: false });

    for (const key of Object.keys(CATALOG) as MetricKey[]) metrics.record(key, 1, {});
    metrics.recordEvent({ kind: 'usage', requestId: 'r', usage: usage() });
    const names = [...(await harness.collect()).keys()].sort();

    expect(names.filter((name) => name.startsWith('gen_ai.'))).toEqual([]);
    expect(names).toEqual([
      'vernllm.call.attempts',
      'vernllm.call.duration',
      'vernllm.circuit.transitions',
      'vernllm.fallback.count',
      'vernllm.rate_limit.wait',
      'vernllm.retry.count',
      'vernllm.retry.delay',
      'vernllm.usage_failure.count',
    ]);
  });
});

describe('normalizeModel', () => {
  it('applies to both model attributes and no other', async () => {
    const { harness, metrics } = setup({ normalizeModel: (model) => model.split(':')[0]! });

    metrics.record('operationDuration', 1, {
      'gen_ai.request.model': 'ft:gpt-4o:acme',
      'other.attr': 'ft:keep',
    });
    metrics.record('retryCount', 1, { 'vernllm.model': 'ft:gpt-4o:acme' });
    const collected = await harness.collect();

    expect(pointsOf(collected.get('gen_ai.client.operation.duration'))[0]?.attributes).toEqual({
      'gen_ai.request.model': 'ft',
      'other.attr': 'ft:keep',
    });
    expect(pointsOf(collected.get('vernllm.retry.count'))[0]?.attributes).toEqual({
      'vernllm.model': 'ft',
    });
  });

  it('normalizes each unique model once per metrics instance', async () => {
    const normalizeModel = vi.fn((model: string) => model.split(':')[0]!);
    const { harness, metrics } = setup({ normalizeModel });

    metrics.record('operationDuration', 1, {
      'gen_ai.request.model': 'ft:gpt-4o:acme',
      'vernllm.model': 'ft:gpt-4o:acme',
    });
    metrics.record('retryCount', 1, { 'vernllm.model': 'ft:gpt-4o:acme' });
    const collected = await harness.collect();

    expect(normalizeModel).toHaveBeenCalledTimes(1);
    expect(pointsOf(collected.get('gen_ai.client.operation.duration'))[0]?.attributes).toEqual({
      'gen_ai.request.model': 'ft',
      'vernllm.model': 'ft',
    });
    expect(pointsOf(collected.get('vernllm.retry.count'))[0]?.attributes).toEqual({
      'vernllm.model': 'ft',
    });
  });

  it('keeps its cache bounded however many models it sees', async () => {
    const normalizeModel = vi.fn((model: string) => model.split(':')[0]!);
    const { metrics } = setup({ normalizeModel });

    const limit = NORMALIZED_MODEL_CACHE_LIMIT;
    for (let index = 0; index <= limit; index++) {
      metrics.record('retryCount', 1, { 'vernllm.model': `ft:${index}` });
    }
    // The first model was evicted when the limit was passed, so it is normalized again.
    metrics.record('retryCount', 1, { 'vernllm.model': 'ft:0' });
    // A recent one is still cached.
    metrics.record('retryCount', 1, { 'vernllm.model': `ft:${limit}` });

    expect(normalizeModel).toHaveBeenCalledTimes(limit + 2);
  });

  it('keeps the raw model and logs when the normalizer throws', async () => {
    const { harness, metrics, logger } = setup({
      normalizeModel: () => {
        throw new Error('bad normalizer');
      },
    });

    metrics.record('operationDuration', 1, { 'gen_ai.request.model': 'gpt-4o' });
    const [point] = pointsOf((await harness.collect()).get('gen_ai.client.operation.duration'));

    expect(point?.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: normalizeModel failed',
      expect.objectContaining({ message: 'bad normalizer' }),
    );
  });

  it.each(['', 42, null, undefined])(
    'keeps the raw model for an unusable answer (%s)',
    async (answer) => {
      const { harness, metrics } = setup({ normalizeModel: () => answer as never });

      metrics.record('operationDuration', 1, { 'gen_ai.request.model': 'gpt-4o' });
      const [point] = pointsOf((await harness.collect()).get('gen_ai.client.operation.duration'));

      expect(point?.attributes['gen_ai.request.model']).toBe('gpt-4o');
    },
  );

  it('leaves a non string model attribute alone', async () => {
    const normalizeModel = vi.fn((model: string) => model);
    const { harness, metrics } = setup({ normalizeModel });

    metrics.record('operationDuration', 1, { 'gen_ai.request.model': 5 });
    await harness.collect();

    expect(normalizeModel).not.toHaveBeenCalled();
  });
});

describe('failure isolation', () => {
  it('logs an instrument creation failure once and does not retry it', () => {
    const createHistogram = vi.fn(() => {
      throw new Error('no instruments today');
    });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const meter = { createHistogram } as unknown as Meter;
    const metrics = createMetrics(normalizeOptions({ meter }), createGuard(logger));

    expect(() => {
      metrics.record('operationDuration', 1, {});
      metrics.record('operationDuration', 2, {});
    }).not.toThrow();

    expect(createHistogram).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: createInstrument failed',
      expect.objectContaining({ message: 'no instruments today' }),
    );
  });

  it('never throws when recording itself fails', () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const meter = {
      createHistogram: () => ({
        record: () => {
          throw new Error('exporter exploded');
        },
      }),
    } as unknown as Meter;
    const metrics = createMetrics(normalizeOptions({ meter }), createGuard(logger));

    expect(() => metrics.record('operationDuration', 1, {})).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] otel: recordMetric failed',
      expect.objectContaining({ message: 'exporter exploded' }),
    );
  });

  it('never throws for an event of an unexpected shape', () => {
    const { metrics, logger } = setup();

    expect(() => metrics.recordEvent(null as never)).not.toThrow();
    expect(() => metrics.recordEvent({ kind: 'usage' } as never)).not.toThrow();
    expect(() => metrics.recordEvent({ kind: 'unheard_of' } as never)).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('recordEvent', () => {
  const providerNames = { primary: 'openai', 'fallback[0]': 'anthropic' };

  it('records a retry as a count and a delay in seconds', async () => {
    const { harness, metrics } = setup({ providerNames });

    metrics.recordEvent({
      kind: 'retry',
      requestId: 'req-secret-123',
      provider: 'primary',
      model: 'gpt-4o',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1500,
      retryAfterHonored: true,
      error: apiError,
    });
    const collected = await harness.collect();

    expect(pointsOf(collected.get('vernllm.retry.count'))).toEqual([
      {
        attributes: {
          'vernllm.provider': 'openai',
          'vernllm.model': 'gpt-4o',
          'error.type': 'server_error',
          'vernllm.retry_after_honored': true,
        },
        value: 1,
      },
    ]);

    const [delay] = pointsOf(collected.get('vernllm.retry.delay'));
    expect(delay?.attributes).toEqual({ 'vernllm.provider': 'openai', 'vernllm.model': 'gpt-4o' });
    expect(histogramOf(delay).sum).toBe(1.5);
  });

  it('records a fallback with mapped from and to targets', async () => {
    const { harness, metrics } = setup({ providerNames });

    metrics.recordEvent({
      kind: 'fallback',
      requestId: 'r',
      from: 'primary',
      to: 'fallback[0]',
      fromIndex: 0,
      toIndex: 1,
      error: apiError,
      elapsedMs: 10,
    });

    expect(pointsOf((await harness.collect()).get('vernllm.fallback.count'))).toEqual([
      {
        attributes: { 'vernllm.fallback.from': 'openai', 'vernllm.fallback.to': 'anthropic' },
        value: 1,
      },
    ]);
  });

  it('leaves an unmapped fallback target as its raw label', async () => {
    const { harness, metrics } = setup();

    metrics.recordEvent({
      kind: 'fallback',
      requestId: 'r',
      from: 'primary',
      to: 'fallback[3]',
      fromIndex: 0,
      toIndex: 4,
      error: apiError,
      elapsedMs: 1,
    });

    const [point] = pointsOf((await harness.collect()).get('vernllm.fallback.count'));
    expect(point?.attributes).toEqual({
      'vernllm.fallback.from': 'primary',
      'vernllm.fallback.to': 'fallback[3]',
    });
  });

  it('records a rate limit wait in seconds with its reason', async () => {
    const { harness, metrics } = setup({ providerNames });

    metrics.recordEvent({
      kind: 'rate_limited',
      requestId: 'r',
      provider: 'primary',
      model: 'gpt-4o',
      waitedMs: 250,
      reason: 'rpm',
    });
    const [point] = pointsOf((await harness.collect()).get('vernllm.rate_limit.wait'));

    expect(point?.attributes).toEqual({
      'vernllm.provider': 'openai',
      'vernllm.model': 'gpt-4o',
      'vernllm.rate_limit.reason': 'rpm',
    });
    expect(histogramOf(point).sum).toBe(0.25);
  });

  it('records a circuit transition', async () => {
    const { harness, metrics } = setup({ providerNames });

    metrics.recordEvent({
      kind: 'circuit_state',
      provider: 'primary',
      model: 'gpt-4o',
      from: 'closed',
      to: 'open',
      consecutiveFailures: 5,
    });

    expect(pointsOf((await harness.collect()).get('vernllm.circuit.transitions'))).toEqual([
      {
        attributes: {
          'vernllm.provider': 'openai',
          'vernllm.model': 'gpt-4o',
          'vernllm.circuit.from': 'closed',
          'vernllm.circuit.to': 'open',
        },
        value: 1,
      },
    ]);
  });

  it('records input and output tokens as separate points', async () => {
    const { harness, metrics } = setup({ providerNames });

    metrics.recordEvent({ kind: 'usage', requestId: 'r', usage: usage() });
    const points = pointsOf((await harness.collect()).get('gen_ai.client.token.usage'));

    const byType = Object.fromEntries(
      points.map((point) => [point.attributes['gen_ai.token.type'], point]),
    );

    expect(Object.keys(byType).sort()).toEqual(['input', 'output']);
    expect(histogramOf(byType.input).sum).toBe(12);
    expect(histogramOf(byType.output).sum).toBe(34);
    expect(byType.input?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.token.type': 'input',
    });
  });

  it('omits the provider and model attributes when the usage has none', async () => {
    const { harness, metrics } = setup();

    metrics.recordEvent({
      kind: 'usage',
      requestId: 'r',
      usage: usage({ provider: undefined, model: '' }),
    });
    const [point] = pointsOf((await harness.collect()).get('gen_ai.client.token.usage'));

    expect(point?.attributes).not.toHaveProperty('gen_ai.provider.name');
    expect(point?.attributes).not.toHaveProperty('gen_ai.request.model');
  });

  it('omits the model attribute of a usage failure that has none', async () => {
    const { harness, metrics } = setup();

    metrics.recordEvent({
      kind: 'usage_failure',
      requestId: 'r',
      usage: usage({ provider: undefined, model: '' }),
      error: apiError,
    });

    expect(pointsOf((await harness.collect()).get('vernllm.usage_failure.count'))).toEqual([
      { attributes: {}, value: 1 },
    ]);
  });

  it('skips a token count that is not a finite non negative number', async () => {
    const { harness, metrics } = setup();

    metrics.recordEvent({
      kind: 'usage',
      requestId: 'r',
      usage: usage({ promptTokens: Number.NaN, completionTokens: -3 }),
    });

    expect((await harness.collect()).has('gen_ai.client.token.usage')).toBe(false);
  });

  it('records zero tokens', async () => {
    const { harness, metrics } = setup();

    metrics.recordEvent({
      kind: 'usage',
      requestId: 'r',
      usage: usage({ promptTokens: 0, completionTokens: 0 }),
    });

    expect(pointsOf((await harness.collect()).get('gen_ai.client.token.usage'))).toHaveLength(2);
  });

  it('counts a usage failure and still records the tokens it spent', async () => {
    const { harness, metrics } = setup({ providerNames });

    metrics.recordEvent({ kind: 'usage_failure', requestId: 'r', usage: usage(), error: apiError });
    const collected = await harness.collect();

    expect(pointsOf(collected.get('gen_ai.client.token.usage'))).toHaveLength(2);
    expect(pointsOf(collected.get('vernllm.usage_failure.count'))).toEqual([
      { attributes: { 'vernllm.provider': 'openai', 'vernllm.model': 'gpt-4o' }, value: 1 },
    ]);
  });

  it('records nothing for a middleware event', async () => {
    const { harness, metrics } = setup();

    metrics.recordEvent({
      kind: 'middleware',
      requestId: 'r',
      middleware: 'guard',
      hook: 'wrap_short_circuit',
    });

    expect((await harness.collect()).size).toBe(0);
  });

  it('never puts a request id or an error message on any metric attribute', async () => {
    const { harness, metrics } = setup({ providerNames });
    const requestId = 'req-secret-123';
    const events: VernLLMEvent[] = [
      {
        kind: 'retry',
        requestId,
        provider: 'primary',
        model: 'gpt-4o',
        attempt: 1,
        maxRetries: 2,
        delayMs: 10,
        retryAfterHonored: false,
        error: apiError,
      },
      {
        kind: 'fallback',
        requestId,
        from: 'primary',
        to: 'fallback[0]',
        fromIndex: 0,
        toIndex: 1,
        error: apiError,
        elapsedMs: 1,
      },
      {
        kind: 'rate_limited',
        requestId,
        provider: 'primary',
        model: 'gpt-4o',
        waitedMs: 5,
        reason: 'tpm',
      },
      { kind: 'usage', requestId, usage: usage({ requestId }) },
      { kind: 'usage_failure', requestId, usage: usage({ requestId }), error: apiError },
    ];

    for (const event of events) metrics.recordEvent(event);

    const values = [...(await harness.collect()).values()].flatMap((metric) =>
      pointsOf(metric).flatMap((point) => Object.values(point.attributes)),
    );

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(String(value)).not.toContain(requestId);
      expect(String(value)).not.toContain('secret');
    }
  });
});
