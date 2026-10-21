import { fail, isPlainObject, stringList } from './validate.utils.js';

import type { DimensionExtractor, Enricher, LoggerMiddlewareOptions } from '../../types/index.js';

// Series are keyed by these, so a user dimension with the same name would silently collide.
const RESERVED_DIMENSIONS: ReadonlySet<string> = new Set([
  'metric',
  'provider',
  'model',
  'streaming',
]);

export function normalizeContext(value: string[] | undefined): readonly string[] {
  return Object.freeze(value === undefined ? [] : stringList(value, 'context'));
}

export function normalizeDimensions(
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

export function normalizeEnrich(value: LoggerMiddlewareOptions['enrich']): readonly Enricher[] {
  if (value === undefined) return Object.freeze([]);

  const list = Array.isArray(value) ? value : [value];
  list.forEach((item, index) => {
    if (typeof item !== 'function') {
      fail(`enrich${Array.isArray(value) ? `[${index}]` : ''} must be a function`);
    }
  });
  return Object.freeze([...list]);
}
