import { describe, expect, it } from 'vitest';

import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { memorySink } from '../../../../src/sinks.js';

import type { LoggerMiddlewareOptions } from '../../../../src/index.js';

const bad = (options: unknown) => () => normalizeOptions(options as LoggerMiddlewareOptions);

describe('normalizeOptions defaults', () => {
  it('resolves every default once', () => {
    const config = normalizeOptions(undefined);

    expect(config.level).toBe('info');
    expect(config.percentiles).toEqual([0.5, 0.9, 0.95, 0.99]);
    expect(config.window).toEqual({ durationMs: 60_000, slots: 6 });
    expect(config.slowCall).toEqual({ thresholdMs: undefined, aboveLivePercentile: undefined });
    expect(config.minSamples).toBe(20);
    expect(config.maxSeries).toBe(200);
    expect(config.sampleSuccess).toBe(1);
    expect(config.errorGrouping).toBe(true);
    expect(config.context).toEqual([]);
    expect(config.dimensions.size).toBe(0);
    expect(config.enrich).toEqual([]);
    expect(config.summary).toBeUndefined();
    expect(config.name).toBe('logger');
    expect(typeof config.sink.write).toBe('function');
    expect(config.keepCustomEvent('usage.budget_warning')).toBe(true);
  });

  it('treats an empty options object like no options', () => {
    // The default sink and the event predicate are fresh functions each time, so they are
    // compared by behavior instead.
    const { sink: emptySink, keepCustomEvent: emptyKeep, ...empty } = normalizeOptions({});
    const { sink: noneSink, keepCustomEvent: noneKeep, ...none } = normalizeOptions(undefined);

    expect(empty).toEqual(none);
    expect(typeof emptySink.write).toBe(typeof noneSink.write);
    expect(emptyKeep('usage.x')).toBe(noneKeep('usage.x'));
  });

  it('returns a frozen config', () => {
    const config = normalizeOptions({ context: ['tenantId'], percentiles: [0.5, 0.99] });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.window)).toBe(true);
    expect(Object.isFrozen(config.context)).toBe(true);
    expect(Object.isFrozen(config.percentiles)).toBe(true);
  });

  it('copies list options so later changes by the caller cannot reach the config', () => {
    const context = ['tenantId'];
    const percentiles = [0.5, 0.99];
    const config = normalizeOptions({ context, percentiles });

    context.push('other');
    percentiles.push(0.999);

    expect(config.context).toEqual(['tenantId']);
    expect(config.percentiles).toEqual([0.5, 0.99]);
  });
});

describe('normalizeOptions values', () => {
  it('keeps what the caller set', () => {
    const sink = memorySink();
    const onSummary = () => {};
    const dimension = () => 'x';
    const enrich = () => ({ a: 1 });
    const config = normalizeOptions({
      sink,
      level: 'warn',
      percentiles: [0.5, 0.95],
      window: { durationMs: 30_000, slots: 3 },
      slowCall: { thresholdMs: 5000, aboveLivePercentile: 0.99 },
      minSamples: 5,
      maxSeries: 10,
      sample: { success: 0.25 },
      errorGrouping: false,
      context: ['tenantId', 'feature', 'tenantId'],
      dimensions: { tier: dimension },
      enrich,
      summary: { everyMs: 10_000, onSummary },
      name: 'calls',
      logger: 'silent',
    });

    expect(config.sink).toBe(sink);
    expect(config.level).toBe('warn');
    expect(config.percentiles).toEqual([0.5, 0.95]);
    expect(config.window).toEqual({ durationMs: 30_000, slots: 3 });
    expect(config.slowCall).toEqual({ thresholdMs: 5000, aboveLivePercentile: 0.99 });
    expect(config.minSamples).toBe(5);
    expect(config.maxSeries).toBe(10);
    expect(config.sampleSuccess).toBe(0.25);
    expect(config.errorGrouping).toBe(false);
    expect(config.context).toEqual(['tenantId', 'feature']);
    expect(config.dimensions.get('tier')).toBe(dimension);
    expect(config.enrich).toEqual([enrich]);
    expect(config.summary).toEqual({ everyMs: 10_000, onSummary });
    expect(config.name).toBe('calls');
    expect(config.logger).toBe('silent');
  });

  it('accepts a list of enrichers and keeps their order', () => {
    const a = () => ({ a: 1 });
    const b = () => ({ b: 2 });
    expect(normalizeOptions({ enrich: [a, b] }).enrich).toEqual([a, b]);
  });

  it('defaults the summary period when only a callback is given', () => {
    const config = normalizeOptions({ summary: { onSummary: () => {} } });
    expect(config.summary?.everyMs).toBe(60_000);
  });

  it('accepts a sample rate of exactly 0 and 1', () => {
    expect(normalizeOptions({ sample: { success: 0 } }).sampleSuccess).toBe(0);
    expect(normalizeOptions({ sample: { success: 1 } }).sampleSuccess).toBe(1);
  });

  it('accepts the smallest and largest slot counts at the minimum slot length', () => {
    expect(() => normalizeOptions({ window: { durationMs: 2000, slots: 2 } })).not.toThrow();
    expect(() => normalizeOptions({ window: { durationMs: 60_000, slots: 60 } })).not.toThrow();
  });
});

describe('normalizeOptions validation', () => {
  it.each([[null], ['x'], [42], [[]]])('rejects %j as the options object', (value) => {
    expect(bad(value)).toThrow('loggerMiddleware: options must be an object');
  });

  it.each([
    [{ sink: {} }, 'sink must be an object with a write function'],
    [{ sink: { write: 1 } }, 'sink must be an object with a write function'],
    [{ sink: null }, 'sink must be an object with a write function'],
    [{ level: 'trace' }, 'level must be one of'],
    [{ level: null }, 'level must be one of'],
    [{ percentiles: [] }, 'percentiles must be a non empty array'],
    [{ percentiles: 0.5 }, 'percentiles must be a non empty array'],
    [{ percentiles: [0] }, 'percentiles[0] must be a number between 0 and 1'],
    [{ percentiles: [0.5, 1] }, 'percentiles[1] must be a number between 0 and 1'],
    [{ percentiles: [0.5, Number.NaN] }, 'percentiles[1] must be a number between 0 and 1'],
    [{ percentiles: [0.9, 0.5] }, 'percentiles must be sorted ascending and unique'],
    [{ percentiles: [0.5, 0.5] }, 'percentiles must be sorted ascending and unique'],
    [{ window: 5 }, 'window must be an object'],
    [{ window: { slots: 1 } }, 'window.slots must be an integer from 2 to 60'],
    [
      { window: { slots: 61, durationMs: 600_000 } },
      'window.slots must be an integer from 2 to 60',
    ],
    [{ window: { slots: 2.5 } }, 'window.slots must be a positive integer'],
    [{ window: { durationMs: 0 } }, 'window.durationMs must be a positive number'],
    [{ window: { durationMs: Number.POSITIVE_INFINITY } }, 'window.durationMs must be a positive'],
    [{ window: { durationMs: 5000, slots: 6 } }, 'window.durationMs divided by window.slots'],
    [{ slowCall: 'x' }, 'slowCall must be an object'],
    [{ slowCall: { thresholdMs: -1 } }, 'slowCall.thresholdMs must be a positive number'],
    [{ slowCall: { aboveLivePercentile: 1 } }, 'slowCall.aboveLivePercentile must be a number'],
    [{ minSamples: 0 }, 'minSamples must be a positive integer'],
    [{ maxSeries: 1.5 }, 'maxSeries must be a positive integer'],
    [{ sample: 1 }, 'sample must be an object'],
    [{ sample: { success: 1.1 } }, 'sample.success must be a number from 0 to 1'],
    [{ sample: { success: -0.1 } }, 'sample.success must be a number from 0 to 1'],
    [{ sample: { success: Number.NaN } }, 'sample.success must be a number from 0 to 1'],
    [{ sample: { success: '0.5' } }, 'sample.success must be a number from 0 to 1'],
    [{ sample: { success: null } }, 'sample.success must be a number from 0 to 1'],
    [{ errorGrouping: 'yes' }, 'errorGrouping must be a boolean'],
    [{ context: 'tenantId' }, 'context must be an array of strings'],
    [{ context: [''] }, 'context must contain only non empty strings'],
    [{ context: [1] }, 'context must contain only non empty strings'],
    [{ dimensions: [] }, 'dimensions must be an object'],
    [{ dimensions: { tier: 'x' } }, 'dimensions.tier must be a function'],
    [{ dimensions: { provider: () => 'x' } }, 'dimensions.provider is a reserved name'],
    [{ dimensions: { metric: () => 'x' } }, 'dimensions.metric is a reserved name'],
    [{ dimensions: { ' ': () => 'x' } }, 'dimensions names must be non empty'],
    [{ enrich: 'x' }, 'enrich must be a function'],
    [{ enrich: [() => ({}), 3] }, 'enrich[1] must be a function'],
    [{ summary: 5 }, 'summary must be an object'],
    [{ summary: { everyMs: 500 } }, 'summary.everyMs must be at least 1000 ms'],
    [{ summary: { everyMs: 0 } }, 'summary.everyMs must be a positive number'],
    [{ summary: { onSummary: 'x' } }, 'summary.onSummary must be a function'],
    [{ name: '' }, 'name must be a non-empty string'],
    [{ name: 5 }, 'name must be a non-empty string'],
    [{ logger: 'loud' }, "logger must be a Logger or 'silent'"],
    [{ logger: null }, "logger must be a Logger or 'silent'"],
  ])('rejects %j', (options, message) => {
    expect(bad(options)).toThrow(`loggerMiddleware: ${message}`);
  });
});
