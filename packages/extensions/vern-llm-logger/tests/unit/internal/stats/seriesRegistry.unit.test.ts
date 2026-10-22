import { describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import {
  attachTallies,
  type AttemptTally,
} from '../../../../src/internal/stats/attemptTally.utils.js';
import { SeriesRegistry } from '../../../../src/internal/stats/seriesRegistry.js';

import type { CallLogRecord, LoggerMiddlewareOptions } from '../../../../src/index.js';

let id = 0;
const call = (extra: Partial<CallLogRecord> = {}): CallLogRecord => ({
  kind: 'call',
  v: 1,
  ts: '2026-01-01T00:00:00.000Z',
  requestId: `req_${++id}`,
  outcome: 'ok',
  level: 'info',
  provider: 'primary',
  model: 'gpt-4o',
  attempts: 1,
  retries: 0,
  streaming: false,
  durationMs: 100,
  queueWaitMs: 0,
  retryDelayMs: 0,
  path: [],
  ...extra,
});

function setup(options: LoggerMiddlewareOptions = {}) {
  const clock = { now: 0 };
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = normalizeOptions({ logger: 'silent', minSamples: 3, ...options });
  const registry = new SeriesRegistry(config, createGuard(logger), () => clock.now);
  return { registry, clock, logger };
}

const fill = (registry: SeriesRegistry, n: number, extra: Partial<CallLogRecord> = {}) => {
  for (let i = 0; i < n; i++) registry.observe(call(extra));
};

describe('what is timed and what is counted', () => {
  it('times a successful provider call and counts everything else', () => {
    const { registry } = setup();
    fill(registry, 3);
    registry.observe(call({ outcome: 'error', durationMs: 5 }));
    registry.observe(call({ outcome: 'rejected', durationMs: 5 }));
    registry.observe(call({ outcome: 'aborted', durationMs: 5 }));
    registry.observe(call({ cache: 'hit', attempts: 0, durationMs: 1 }));
    registry.observe(call({ cache: 'join', attempts: 0, durationMs: 1 }));

    const all = registry.snapshot().series.find((s) => s.metric === 'durationMs')!;

    expect(all.count).toBe(3);
    expect(all).toMatchObject({ errors: 1, rejections: 1, aborts: 1, cacheHits: 2 });
  });

  it('keeps a short circuited answer out of the latency series', () => {
    const { registry } = setup();
    registry.observe(call({ attempts: 0, shortCircuitedBy: 'mock' }));

    expect(registry.snapshot().series).toEqual([]);
  });

  it('times optional metrics only when the record has them', () => {
    const { registry } = setup();
    fill(registry, 3, { ttftMs: 40, attemptMs: 90, outputTokensPerSec: 50, streaming: true });
    fill(registry, 3);

    const metrics = registry
      .snapshot()
      .series.filter((s) => s.dimensions.provider === undefined)
      .map((s) => [s.metric, s.count]);

    expect(metrics).toEqual([
      ['durationMs', 6],
      ['ttftMs', 3],
      ['attemptMs', 3],
      ['queueWaitMs', 6],
      ['outputTokensPerSec', 3],
    ]);
  });
});

describe('percentiles and minSamples', () => {
  it('reports no quantiles below minSamples, and does not answer a quantile query', () => {
    const { registry } = setup({ minSamples: 5 });
    fill(registry, 4);

    expect(registry.snapshot().series[0]!.quantiles).toEqual({});
    expect(registry.quantile({}, 0.99)).toBeUndefined();

    fill(registry, 1);
    expect(registry.quantile({}, 0.99)).toBeCloseTo(100, 0);
    expect(Object.keys(registry.snapshot().series[0]!.quantiles)).toEqual([
      '0.5',
      '0.9',
      '0.95',
      '0.99',
    ]);
  });

  it('splits by provider, and merges matching series for a partial filter', () => {
    const { registry } = setup();
    fill(registry, 5, { provider: 'a', model: 'm1', durationMs: 100 });
    fill(registry, 5, { provider: 'a', model: 'm2', durationMs: 300 });
    fill(registry, 5, { provider: 'b', model: 'm1', durationMs: 900 });

    expect(registry.quantile({ provider: 'b' }, 0.5)).toBeCloseTo(900, -1);
    expect(registry.quantile({ provider: 'a', model: 'm1' }, 0.5)).toBeCloseTo(100, -1);
    // Provider "a" spans two models, so its median sits between them.
    expect(registry.quantile({ provider: 'a' }, 1)).toBeCloseTo(300, -1);
    expect(registry.quantile({}, 1)).toBeCloseTo(900, -1);
    expect(registry.quantile({ provider: 'nobody' }, 0.5)).toBeUndefined();
  });

  it('counts the all calls series once per call, not once per matching series', () => {
    const { registry } = setup();
    fill(registry, 4, { provider: 'a' });
    fill(registry, 4, { provider: 'b' });

    const all = registry.snapshot().series.find((s) => Object.keys(s.dimensions).length === 0)!;

    expect(all.count).toBe(8);
  });
});

describe('the window', () => {
  it('drops calls once they are older than the window', () => {
    const { registry, clock } = setup({ window: { durationMs: 6000, slots: 6 } });
    fill(registry, 5);

    clock.now = 7000;
    expect(registry.quantile({}, 0.5)).toBeUndefined();
    expect(registry.snapshot().series).toEqual([]);
  });

  it('counts failures only while they are inside the window', () => {
    const { registry, clock } = setup({ window: { durationMs: 6000, slots: 6 } });
    registry.observe(call({ outcome: 'error' }));
    expect(registry.snapshot().series[0]).toMatchObject({ count: 0, errors: 1 });

    clock.now = 7000;
    expect(registry.snapshot().series).toEqual([]);
  });

  it('empties on reset', () => {
    const { registry } = setup();
    fill(registry, 5);
    registry.reset();

    expect(registry.snapshot().series).toEqual([]);
  });
});

describe('the cap', () => {
  it('sends series past maxSeries to one shared series and warns once', () => {
    const { registry, logger } = setup({ maxSeries: 2 });
    for (const provider of ['a', 'b', 'c', 'd', 'e']) fill(registry, 3, { provider });

    const dimensions = registry.snapshot().series.map((s) => Object.keys(s.dimensions).join());
    expect(dimensions).toContain('__other__');
    expect(new Set(registry.snapshot().series.map((s) => JSON.stringify(s.dimensions))).size).toBe(
      4,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('user dimensions', () => {
  it('splits series by an extractor, and drops one that throws or is not a string', () => {
    const { registry, logger } = setup({
      dimensions: {
        tenant: (record) => record.context?.tenant as string | undefined,
        broken: () => {
          throw new Error('boom');
        },
        number: () => 5 as unknown as string,
        empty: () => '',
      },
    });
    fill(registry, 3, { context: { tenant: 'acme' } });

    const grouped = registry.snapshot().series.find((s) => s.dimensions.tenant === 'acme')!;
    expect(grouped.dimensions).toEqual({
      provider: 'primary',
      model: 'gpt-4o',
      streaming: 'false',
      tenant: 'acme',
    });
    expect(logger.error).toHaveBeenCalled();
    expect(registry.quantile({ tenant: 'acme' }, 0.5)).toBeCloseTo(100, 0);
  });

  it('keeps values that contain separators from colliding', () => {
    const { registry } = setup({ dimensions: { k: (record) => record.context?.k as string } });
    fill(registry, 3, { context: { k: 'a|b' } });
    fill(registry, 3, { context: { k: 'a' } });

    expect(registry.quantile({ k: 'a|b' }, 0.5)).toBeDefined();
    expect(
      registry
        .snapshot()
        .series.filter((s) => s.metric === 'durationMs' && s.dimensions.k !== undefined),
    ).toHaveLength(2);
  });
});

describe('attribution of calls that never answered', () => {
  it('counts a failure against the last target tried', () => {
    const { registry } = setup();
    registry.observe(
      call({
        outcome: 'error',
        provider: undefined,
        model: undefined,
        path: [{ provider: 'b', model: 'm', attempts: 1, outcome: 'error', elapsedMs: 5 }],
      }),
    );

    expect(registry.snapshot().series.find((s) => s.dimensions.provider === 'b')!.errors).toBe(1);
  });

  it('counts a failure with no target only in the all calls series', () => {
    const { registry } = setup();
    registry.observe(call({ outcome: 'rejected', provider: undefined, model: undefined }));

    const series = registry.snapshot().series;
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ dimensions: {}, rejections: 1 });
  });
});

describe('the slow call inputs', () => {
  it('serves the cached live percentile once the series has minSamples', () => {
    const { registry, clock } = setup({ slowCall: { aboveLivePercentile: 0.5 } });
    const sample = call();
    fill(registry, 2);
    expect(registry.livePercentileFor(sample)).toBeUndefined();

    fill(registry, 2);
    expect(registry.livePercentileFor(sample)).toBeCloseTo(100, 0);

    // Slower traffic in the same period does not move the cached figure.
    clock.now = 10;
    fill(registry, 20, { durationMs: 5000 });
    expect(registry.livePercentileFor(sample)).toBeCloseTo(100, 0);
  });

  it('names the slowest request in the window as an exemplar', () => {
    const { registry } = setup();
    registry.observe(call({ requestId: 'quick', durationMs: 10 }));
    registry.observe(call({ requestId: 'crawl', durationMs: 9000 }));
    registry.observe(call({ requestId: 'medium', durationMs: 300 }));

    expect(registry.exemplarOf({})).toEqual({ requestId: 'crawl', durationMs: 9000 });
    expect(registry.exemplarOf({ provider: 'nobody' })).toBeUndefined();
  });
});

describe('exemplars and fallbacks', () => {
  it('carries the allowlisted context of the slowest call as the exemplar fields', () => {
    const { registry } = setup({ context: ['tenantId'] });
    fill(registry, 3);
    registry.observe(call({ durationMs: 900, requestId: 'slow', context: { tenantId: 'acme' } }));

    expect(registry.exemplarOf({})).toEqual({
      requestId: 'slow',
      durationMs: 900,
      fields: { tenantId: 'acme' },
    });
  });

  it('leaves the fields out when the slowest call had no context', () => {
    const { registry } = setup();
    registry.observe(call({ durationMs: 900, requestId: 'slow' }));

    expect(registry.exemplarOf({})).toEqual({ requestId: 'slow', durationMs: 900 });
    expect(registry.exemplarOf({ provider: 'nobody' })).toBeUndefined();
  });

  it('finds the exemplar of the shared overflow series', () => {
    const { registry } = setup({ maxSeries: 1 });
    registry.observe(call({ provider: 'a' }));
    registry.observe(call({ provider: 'b', durationMs: 700, requestId: 'over' }));

    expect(registry.exemplarOf({ __other__: 'true' })).toMatchObject({ requestId: 'over' });
  });

  it('reads the all calls series for a record that has no dimensions', () => {
    const { registry } = setup();
    fill(registry, 3);
    const orphan = call({ provider: undefined, model: undefined });

    expect(registry.livePercentileFor(orphan)).toBeUndefined();
  });

  it('cuts a dimension value past 128 characters', () => {
    const { registry } = setup({ dimensions: { long: () => 'x'.repeat(500) } });
    registry.observe(call());

    const dimension = registry.snapshot().series.find((s) => 'long' in s.dimensions)!.dimensions;
    expect(dimension.long).toHaveLength(128);
  });
});

describe('failureRate quality', () => {
  const tally = (provider: string, responded: number, qualityFailures: number): AttemptTally => ({
    provider,
    model: 'gpt-4o',
    responded,
    qualityFailures,
  });
  const observe = (
    registry: SeriesRegistry,
    tallies: AttemptTally[],
    extra: Partial<CallLogRecord> = {},
  ) => {
    const record = call(extra);
    attachTallies(record, tallies);
    registry.observe(record);
  };

  it('counts each target under its own provider and sums across the groups a filter matches', () => {
    const { registry } = setup();
    observe(registry, [tally('a', 4, 1), tally('b', 2, 0)]);
    observe(registry, [tally('a', 2, 1)]);

    expect(registry.failureRate({ provider: 'a' }, 'quality')).toBeCloseTo(2 / 6);
    expect(registry.failureRate({ provider: 'b' }, 'quality')).toBeUndefined();
    expect(registry.failureRate({ model: 'gpt-4o' }, 'quality')).toBeCloseTo(2 / 8);
    expect(registry.failureRate({}, 'quality')).toBeCloseTo(2 / 8);
  });

  it('forgets attempts once they leave the window', () => {
    const { registry, clock } = setup();
    observe(registry, [tally('a', 5, 5)]);
    expect(registry.failureRate({ provider: 'a' }, 'quality')).toBe(1);

    clock.now += 10 * 60 * 60 * 1000;

    expect(registry.failureRate({ provider: 'a' }, 'quality')).toBeUndefined();
    expect(registry.failureRate({}, 'quality')).toBeUndefined();
  });

  it('still counts the global rate for a call with no provider to key it by', () => {
    const { registry } = setup();
    observe(registry, [tally('a', 3, 3)], { provider: undefined, model: undefined, path: [] });

    expect(registry.failureRate({}, 'quality')).toBe(1);
    expect(registry.failureRate({ provider: 'a' }, 'quality')).toBeUndefined();
  });

  it('answers only for the quality kind', () => {
    const { registry } = setup();
    observe(registry, [tally('a', 5, 5)]);

    expect(registry.failureRate({}, 'latency' as never)).toBeUndefined();
  });

  it('ignores a record with no tallies', () => {
    const { registry } = setup();
    fill(registry, 5);

    expect(registry.failureRate({}, 'quality')).toBeUndefined();
  });
});
