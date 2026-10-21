import { jsonSink } from '../../sinks.js';
import { normalizeCustomEvents } from './customEventsOptions.utils.js';
import {
  fail,
  isPlainObject,
  optionalBoolean,
  optionalFunction,
  optionalObject,
  positiveInteger,
  positiveNumber,
  quantile,
  stringList,
} from './validate.utils.js';

import type {
  DimensionExtractor,
  Enricher,
  LoggerMiddlewareOptions,
  LogLevel,
  ResolvedConfig,
} from '../../types/index.js';

export const DEFAULT_NAME = 'logger';
const DEFAULT_PERCENTILES: readonly number[] = [0.5, 0.9, 0.95, 0.99];
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_SLOTS = 6;
const MIN_SLOT_MS = 1000;
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Series are keyed by these, so a user dimension with the same name would silently collide.
const RESERVED_DIMENSIONS: ReadonlySet<string> = new Set([
  'metric',
  'provider',
  'model',
  'streaming',
]);

export function normalizeOptions(options: LoggerMiddlewareOptions | undefined): ResolvedConfig {
  const opts: LoggerMiddlewareOptions = options === undefined ? {} : options;
  if (!isPlainObject(opts)) fail('options must be an object');

  // Not `??`: an explicit `null` is a mistake to report, not a request for the default.
  const sink = opts.sink === undefined ? jsonSink() : opts.sink;
  if (!isPlainObject(sink) || typeof sink.write !== 'function') {
    fail('sink must be an object with a write function');
  }

  const level = opts.level === undefined ? 'info' : opts.level;
  if (!LEVELS.includes(level)) fail(`level must be one of ${LEVELS.join(', ')}`);

  const percentiles = normalizePercentiles(opts.percentiles);

  optionalObject(opts.window, 'window');
  const slots = positiveInteger(opts.window?.slots, 'window.slots', DEFAULT_SLOTS);
  const durationMs = positiveNumber(
    opts.window?.durationMs,
    'window.durationMs',
    DEFAULT_WINDOW_MS,
  );
  if (slots < 2 || slots > 60) fail('window.slots must be an integer from 2 to 60');
  if (durationMs / slots < MIN_SLOT_MS) {
    fail(`window.durationMs divided by window.slots must be at least ${MIN_SLOT_MS} ms`);
  }

  optionalObject(opts.slowCall, 'slowCall');
  const thresholdMs = positiveNumber(opts.slowCall?.thresholdMs, 'slowCall.thresholdMs');
  const aboveLivePercentile =
    opts.slowCall?.aboveLivePercentile === undefined
      ? undefined
      : quantile(opts.slowCall.aboveLivePercentile, 'slowCall.aboveLivePercentile');

  const minSamples = positiveInteger(opts.minSamples, 'minSamples', 20);
  const maxSeries = positiveInteger(opts.maxSeries, 'maxSeries', 200);

  optionalObject(opts.sample, 'sample');
  const sampleSuccess = opts.sample?.success === undefined ? 1 : opts.sample.success;
  if (typeof sampleSuccess !== 'number' || !(sampleSuccess >= 0 && sampleSuccess <= 1)) {
    fail('sample.success must be a number from 0 to 1');
  }

  optionalBoolean(opts.errorGrouping, 'errorGrouping');
  const context = opts.context === undefined ? [] : stringList(opts.context, 'context');
  const keepCustomEvent = normalizeCustomEvents(opts.customEvents);
  const dimensions = normalizeDimensions(opts.dimensions);
  const enrich = normalizeEnrich(opts.enrich);
  const summary = normalizeSummary(opts.summary);

  if (opts.name !== undefined && (typeof opts.name !== 'string' || opts.name.trim() === '')) {
    fail('name must be a non-empty string');
  }
  if (
    opts.logger !== undefined &&
    opts.logger !== 'silent' &&
    (typeof opts.logger !== 'object' || opts.logger === null)
  ) {
    fail("logger must be a Logger or 'silent'");
  }

  return Object.freeze({
    sink,
    level,
    percentiles,
    window: Object.freeze({ durationMs, slots }),
    slowCall: Object.freeze({ thresholdMs, aboveLivePercentile }),
    minSamples,
    maxSeries,
    sampleSuccess,
    errorGrouping: opts.errorGrouping ?? true,
    context: Object.freeze(context),
    keepCustomEvent,
    dimensions,
    enrich,
    summary,
    logger: opts.logger,
    name: opts.name ?? DEFAULT_NAME,
  });
}

function normalizePercentiles(value: number[] | undefined): readonly number[] {
  if (value === undefined) return DEFAULT_PERCENTILES;
  if (!Array.isArray(value) || value.length === 0) fail('percentiles must be a non empty array');

  const checked = value.map((item, index) => quantile(item, `percentiles[${index}]`));
  for (let i = 1; i < checked.length; i++) {
    if ((checked[i] as number) <= (checked[i - 1] as number)) {
      fail('percentiles must be sorted ascending and unique');
    }
  }
  return Object.freeze(checked);
}

function normalizeDimensions(
  value: LoggerMiddlewareOptions['dimensions'],
): ReadonlyMap<string, DimensionExtractor> {
  const result = new Map<string, DimensionExtractor>();
  if (value === undefined) return result;
  if (!isPlainObject(value)) fail('dimensions must be an object');

  for (const [name, extractor] of Object.entries(value)) {
    if (name.trim() === '') fail('dimensions names must be non empty');
    if (RESERVED_DIMENSIONS.has(name)) fail(`dimensions.${name} is a reserved name`);
    if (typeof extractor !== 'function') fail(`dimensions.${name} must be a function`);
    result.set(name, extractor);
  }
  return result;
}

function normalizeEnrich(value: LoggerMiddlewareOptions['enrich']): readonly Enricher[] {
  if (value === undefined) return Object.freeze([]);

  const list = Array.isArray(value) ? value : [value];
  list.forEach((item, index) => {
    if (typeof item !== 'function')
      fail(`enrich${Array.isArray(value) ? `[${index}]` : ''} must be a function`);
  });
  return Object.freeze([...list]);
}

function normalizeSummary(value: LoggerMiddlewareOptions['summary']): ResolvedConfig['summary'] {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('summary must be an object');

  optionalFunction(value.onSummary, 'summary.onSummary');
  const everyMs = positiveNumber(value.everyMs, 'summary.everyMs', DEFAULT_WINDOW_MS);
  if (everyMs < MIN_SLOT_MS) fail(`summary.everyMs must be at least ${MIN_SLOT_MS} ms`);

  return Object.freeze({ everyMs, onSummary: value.onSummary });
}
