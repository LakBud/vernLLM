import { metrics as metricsApi } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { CATALOG, type MetricKey } from '../../../../src/internal/metrics/catalog.js';
import { createMetrics } from '../../../../src/internal/metrics/metrics.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { DURATION_BUCKETS, TOKEN_USAGE_BUCKETS } from '../../../../src/internal/semconv.js';
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

describe('catalog', () => {
  it('declares every instrument with the documented name, unit, and kind', async () => {
    const { harness, metrics } = setup();

    for (const key of Object.keys(CATALOG) as MetricKey[]) metrics.record(key, 1, {});
    const collected = await harness.collect();

    const summary = Object.fromEntries(
      [...collected.values()].map((metric) => [
        metric.descriptor.name,
        [metric.descriptor.unit, metric.dataPointType === 0 ? 'histogram' : 'counter'],
      ]),
    );

    expect(summary).toEqual({
      'gen_ai.client.token.usage': ['{token}', 'histogram'],
      'gen_ai.client.operation.duration': ['s', 'histogram'],
      'gen_ai.client.operation.time_to_first_chunk': ['s', 'histogram'],
      'vernllm.call.duration': ['s', 'histogram'],
      'vernllm.call.attempts': ['{attempt}', 'histogram'],
      'vernllm.retry.count': ['{retry}', 'counter'],
      'vernllm.retry.delay': ['s', 'histogram'],
      'vernllm.fallback.count': ['{fallback}', 'counter'],
      'vernllm.rate_limit.wait': ['s', 'histogram'],
      'vernllm.circuit.transitions': ['{transition}', 'counter'],
      'vernllm.usage_failure.count': ['{failure}', 'counter'],
    });
  });

  it('applies the bucket boundaries from the spec through instrument advice', async () => {
    const { harness, metrics } = setup();

    metrics.record('tokenUsage', 5, {});
    metrics.record('operationDuration', 0.5, {});
    metrics.record('timeToFirstChunk', 0.5, {});
    metrics.record('callAttempts', 2, {});
    const collected = await harness.collect();

    const boundaries = (name: string) => {
      const [point] = pointsOf(collected.get(name));
      return histogramOf(point).buckets.boundaries;
    };

    expect(boundaries('gen_ai.client.token.usage')).toEqual([...TOKEN_USAGE_BUCKETS]);
    expect(boundaries('gen_ai.client.operation.duration')).toEqual([...DURATION_BUCKETS]);
    expect(boundaries('gen_ai.client.operation.time_to_first_chunk')).toEqual([
      ...DURATION_BUCKETS,
    ]);
    expect(boundaries('vernllm.call.attempts')).toEqual([1, 2, 3, 4, 5, 8, 13]);
  });

  it('flags exactly the three GenAI instruments', () => {
    const genAi = Object.entries(CATALOG)
      .filter(([, spec]) => spec.genAi)
      .map(([key]) => key);

    expect(genAi).toEqual(['tokenUsage', 'operationDuration', 'timeToFirstChunk']);
  });
});
