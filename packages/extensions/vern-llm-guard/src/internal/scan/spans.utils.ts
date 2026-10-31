import { createHash } from 'node:crypto';

import { isImage } from '../segments/isImage.utils.js';

import type { Finding } from '../../types/index.js';
import type { InputSegment } from '../segments/types.js';
import type { Span } from './types.js';

/**
 * What a segment is remembered by. An image is keyed by a hash of its data, so one that comes back
 * in the history is read once. The two kinds cannot meet: no source is called `image`.
 */
export function segmentKey(segment: InputSegment): string {
  const hash = createHash('sha256');
  if (isImage(segment)) {
    hash
      .update('image\u0000')
      .update(segment.source)
      .update('\u0000')
      .update(segment.image.mimeType)
      .update('\u0000')
      .update(segment.image.data);
  } else {
    hash.update(segment.source).update('\u0000').update(segment.text);
  }
  return hash.digest('base64url').slice(0, 22);
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** The segment a finding names, which must be one of those the detector was given. */
function segmentOf(entry: Partial<Finding>, texts: readonly (string | undefined)[]): number {
  const { segment } = entry;
  if (!isCount(segment) || !(segment in texts)) {
    throw new TypeError('a finding names a segment that was not given');
  }
  return segment;
}

/**
 * The label and offsets of a finding, each checked against the text they point into. An image has
 * no text, so `text` is `undefined` and a finding on it can have no offsets.
 */
function spanOf(entry: Partial<Finding>, text: string | undefined): Span {
  if (entry.unscanned === true) {
    // Text always reaches the detector, so "not read" would hide it from every check.
    if (text !== undefined) throw new TypeError('only an image can be marked unscanned');
    return { unscanned: true };
  }
  if (entry.label !== undefined && typeof entry.label !== 'string') {
    throw new TypeError('a finding label must be a string');
  }
  const span: Span = entry.label === undefined ? {} : { label: entry.label };
  if (entry.start === undefined && entry.end === undefined) return span;

  const { start, end } = entry;
  if (
    text === undefined ||
    !isCount(start) ||
    !isCount(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  ) {
    throw new TypeError('a finding span lies outside its segment');
  }
  return { ...span, start, end };
}

/**
 * Groups what a detector returned by the segment it was about, checking every field. `texts` is the
 * text of each segment it was given, and `undefined` for an image.
 */
export function toSpans(found: unknown, texts: readonly (string | undefined)[]): Span[][] {
  if (!Array.isArray(found)) throw new TypeError('a detector must return a list of findings');

  const grouped: Span[][] = texts.map(() => []);
  for (const finding of found as unknown[]) {
    if (typeof finding !== 'object' || finding === null) {
      throw new TypeError('a finding must be an object');
    }
    const entry = finding as Partial<Finding>;
    const segment = segmentOf(entry, texts);
    grouped[segment]!.push(spanOf(entry, texts[segment]));
  }
  return grouped;
}
