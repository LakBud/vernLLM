import { createHash } from 'node:crypto';

import type { Finding, Segment } from '../../types/index.js';
import type { Span } from './types.js';

export function segmentKey(segment: Segment): string {
  return createHash('sha256')
    .update(segment.source)
    .update('\u0000')
    .update(segment.text)
    .digest('base64url')
    .slice(0, 22);
}

/** Groups what a detector returned by the segment it was about, checking every field. */
export function toSpans(found: unknown, texts: readonly string[]): Span[][] {
  if (!Array.isArray(found)) throw new TypeError('a detector must return a list of findings');

  const grouped: Span[][] = texts.map(() => []);
  for (const finding of found as unknown[]) {
    const entry = finding as Partial<Finding> | null;
    const segment = entry?.segment;
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError('a finding must be an object');
    }
    if (typeof segment !== 'number' || !Number.isInteger(segment) || !(segment in texts)) {
      throw new TypeError('a finding names a segment that was not given');
    }
    if (entry.label !== undefined && typeof entry.label !== 'string') {
      throw new TypeError('a finding label must be a string');
    }

    let span: Span = entry.label === undefined ? {} : { label: entry.label };
    if (entry.start !== undefined || entry.end !== undefined) {
      const { start, end } = entry;
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > texts[segment]!.length
      ) {
        throw new TypeError('a finding span lies outside its segment');
      }
      span = { ...span, start, end };
    }
    grouped[segment]!.push(span);
  }
  return grouped;
}
