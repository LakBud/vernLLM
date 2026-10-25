import type { Segment } from '../../types/index.js';

/** Where a segment lives, from the root that was extracted. */
export type Path = readonly (string | number)[];

export interface Extracted {
  segments: Segment[];
  /** One path per segment, in the same order. */
  paths: Path[];
  /**
   * Segments that are scanned but never rewritten, in the same order: a provider's reasoning
   * blocks are signed, so they must go back verbatim.
   */
  fixed: boolean[];
  /** Things no text detector can read, such as images or values nested too deep. */
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
