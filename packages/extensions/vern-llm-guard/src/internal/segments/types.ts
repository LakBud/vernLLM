import type { ImageSegment, Segment } from '../../types/index.js';

/** What the scan reads: text, and images for the detectors that take them. */
export type InputSegment = Segment | ImageSegment;

/** Where a segment lives, from the root that was extracted. */
export type Path = readonly (string | number)[];

/** What was cut out of a value. It holds only text unless images were asked for. */
export interface Extracted<S extends InputSegment = Segment> {
  segments: S[];
  /** One path per segment, in the same order. */
  paths: Path[];
  /**
   * Segments that are scanned but never rewritten, in the same order: a provider's reasoning
   * blocks are signed, so they must go back verbatim.
   */
  fixed: boolean[];
  /** Things no detector can read, such as images no check takes or values nested too deep. */
  unscanned: number;
}

/** A piece of one segment's text to replace. `end` is exclusive. */
export interface Replacement {
  segment: number;
  start: number;
  end: number;
  text: string;
}

/** One piece of a text to replace. `end` is exclusive. */
export interface SpanReplacement {
  start: number;
  end: number;
  text: string;
}
