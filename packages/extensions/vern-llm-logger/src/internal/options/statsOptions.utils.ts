import {
  fail,
  isPlainObject,
  optionalFunction,
  optionalObject,
  positiveInteger,
  positiveNumber,
  quantile,
} from './validate.utils.js';

import type { LoggerMiddlewareOptions, ResolvedConfig } from '../../types/index.js';

const DEFAULT_PERCENTILES: readonly number[] = [0.5, 0.9, 0.95, 0.99];
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_SLOTS = 6;
const MIN_SLOT_MS = 1000;

export function normalizePercentiles(value: number[] | undefined): readonly number[] {
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

export function normalizeWindow(
  value: LoggerMiddlewareOptions['window'],
): ResolvedConfig['window'] {
  optionalObject(value, 'window');
  const slots = positiveInteger(value?.slots, 'window.slots', DEFAULT_SLOTS);
  const durationMs = positiveNumber(value?.durationMs, 'window.durationMs', DEFAULT_WINDOW_MS);
  if (slots < 2 || slots > 60) fail('window.slots must be an integer from 2 to 60');
  if (durationMs / slots < MIN_SLOT_MS) {
    fail(`window.durationMs divided by window.slots must be at least ${MIN_SLOT_MS} ms`);
  }
  return Object.freeze({ durationMs, slots });
}

export function normalizeSlowCall(
  value: LoggerMiddlewareOptions['slowCall'],
): ResolvedConfig['slowCall'] {
  optionalObject(value, 'slowCall');
  const thresholdMs = positiveNumber(value?.thresholdMs, 'slowCall.thresholdMs');
  const aboveLivePercentile =
    value?.aboveLivePercentile === undefined
      ? undefined
      : quantile(value.aboveLivePercentile, 'slowCall.aboveLivePercentile');
  return Object.freeze({ thresholdMs, aboveLivePercentile });
}

export function normalizeSummary(
  value: LoggerMiddlewareOptions['summary'],
): ResolvedConfig['summary'] {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('summary must be an object');

  optionalFunction(value.onSummary, 'summary.onSummary');
  const everyMs = positiveNumber(value.everyMs, 'summary.everyMs', DEFAULT_WINDOW_MS);
  if (everyMs < MIN_SLOT_MS) fail(`summary.everyMs must be at least ${MIN_SLOT_MS} ms`);

  return Object.freeze({ everyMs, onSummary: value.onSummary });
}
