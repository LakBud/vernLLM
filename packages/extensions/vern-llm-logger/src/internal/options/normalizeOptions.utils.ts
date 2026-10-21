import { normalizeCustomEvents } from './customEventsOptions.utils.js';
import {
  normalizeErrorGrouping,
  normalizeLogger,
  normalizeName,
  normalizeSampleSuccess,
} from './pipelineOptions.utils.js';
import { normalizeContext, normalizeDimensions, normalizeEnrich } from './recordOptions.utils.js';
import { normalizeLevel, normalizeSink } from './sinkOptions.utils.js';
import {
  normalizePercentiles,
  normalizeSlowCall,
  normalizeSummary,
  normalizeWindow,
} from './statsOptions.utils.js';
import { fail, isPlainObject, positiveInteger } from './validate.utils.js';

import type { LoggerMiddlewareOptions, ResolvedConfig } from '../../types/index.js';

/** Validates every option once and applies the defaults, throwing on the first bad value. */
export function normalizeOptions(options: LoggerMiddlewareOptions | undefined): ResolvedConfig {
  const opts: LoggerMiddlewareOptions = options === undefined ? {} : options;
  if (!isPlainObject(opts)) fail('options must be an object');

  return Object.freeze({
    sink: normalizeSink(opts.sink),
    level: normalizeLevel(opts.level),
    percentiles: normalizePercentiles(opts.percentiles),
    window: normalizeWindow(opts.window),
    slowCall: normalizeSlowCall(opts.slowCall),
    minSamples: positiveInteger(opts.minSamples, 'minSamples', 20),
    maxSeries: positiveInteger(opts.maxSeries, 'maxSeries', 200),
    sampleSuccess: normalizeSampleSuccess(opts.sample),
    errorGrouping: normalizeErrorGrouping(opts.errorGrouping),
    context: normalizeContext(opts.context),
    keepCustomEvent: normalizeCustomEvents(opts.customEvents),
    dimensions: normalizeDimensions(opts.dimensions),
    enrich: normalizeEnrich(opts.enrich),
    summary: normalizeSummary(opts.summary),
    name: normalizeName(opts.name),
    logger: normalizeLogger(opts.logger),
  });
}
