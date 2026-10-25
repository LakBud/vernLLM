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

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** The segment a finding names, which must be one of those the detector was given. */
function segmentOf(entry: Partial<Finding>, texts: readonly string[]): number {
  const { segment } = entry;
  if (!isCount(segment) || !(segment in texts)) {
    throw new TypeError('a finding names a segment that was not given');
  }
  return segment;
}

/** The label and offsets of a finding, each checked against the text they point into. */
function spanOf(entry: Partial<Finding>, text: string): Span {
  if (entry.label !== undefined && typeof entry.label !== 'string') {
    throw new TypeError('a finding label must be a string');
  }
  const span: Span = entry.label === undefined ? {} : { label: entry.label };
  if (entry.start === undefined && entry.end === undefined) return span;

  const { start, end } = entry;
  if (!isCount(start) || !isCount(end) || start < 0 || end <= start || end > text.length) {
    throw new TypeError('a finding span lies outside its segment');
  }
  return { ...span, start, end };
}

/** Groups what a detector returned by the segment it was about, checking every field. */
export function toSpans(found: unknown, texts: readonly string[]): Span[][] {
  if (!Array.isArray(found)) throw new TypeError('a detector must return a list of findings');

  const grouped: Span[][] = texts.map(() => []);
  for (const finding of found as unknown[]) {
    if (typeof finding !== 'object' || finding === null) {
      throw new TypeError('a finding must be an object');
    }
    const entry = finding as Partial<Finding>;
    const segment = segmentOf(entry, texts);
    grouped[segment]!.push(spanOf(entry, texts[segment]!));
  }
  return grouped;
}
