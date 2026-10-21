import type { CallLogRecord, DimensionExtractor } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';

/** A longer dimension value is cut, so one runaway string cannot bloat a key or a log line. */
const MAX_DIMENSION_LENGTH = 128;

/** The built in dimensions plus every user dimension that yields a non empty string. */
export function dimensionsOf(
  record: Readonly<CallLogRecord>,
  extractors: ReadonlyMap<string, DimensionExtractor>,
  guard: Guard,
): Record<string, string> | undefined {
  const last = record.path[record.path.length - 1];
  const provider = record.provider ?? last?.provider;
  const model = record.model ?? last?.model;
  if (provider === undefined || model === undefined) return undefined;

  const dimensions: Record<string, string> = {
    provider,
    model,
    streaming: String(record.streaming),
  };
  for (const [name, extractor] of extractors) {
    const value = guard(`dimension.${name}`, () => extractor(record), undefined);
    if (typeof value === 'string' && value !== '') {
      dimensions[name] = value.slice(0, MAX_DIMENSION_LENGTH);
    }
  }
  return dimensions;
}
