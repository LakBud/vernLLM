import type { Detector, Segment } from '../../types/index.js';
import type { Span } from '../scan/types.js';
import type { InputSegment } from '../segments/types.js';
import type { Limit } from './limit.js';

/**
 * A finding of a hosted detector: a label, and offsets only when it can locate it. A hit that is
 * only `unscanned` says the provider could not read the segment, such as an image of a format it
 * does not take.
 */
export type Hit = Span;

/** A detector, and the same detector narrowed to some kinds of finding. */
export type HostedDetector<Kind extends string> = Detector & {
  /** Another detector over the same requests and cache, returning only these kinds. */
  only(...kinds: Kind[]): Detector;
};

/** The options `only` takes after the kinds, for a detector whose findings have levels. */
export interface OnlyOptions {
  /** Findings below this level are left out. 1 to 3, default 1. */
  minLevel?: number;
}

/** Asks the provider about texts, one list of hits per segment, in order. */
export type Analyze = (
  segments: readonly Segment[],
  signal: AbortSignal,
  limit: Limit,
) => Promise<Hit[][]>;

/**
 * An `Analyze` that also takes image segments, which the guard gives only to a detector that asked
 * for them. It fits wherever an `Analyze` does.
 */
export type ImageAnalyze = (
  segments: readonly InputSegment[],
  signal: AbortSignal,
  limit: Limit,
) => Promise<Hit[][]>;

export interface HostedConfig<Kind extends string> {
  /** The detector's name, for error messages. */
  name: string;
  kinds: readonly Kind[];
  /** The kind a label belongs to. */
  kindOf(label: string): string;
  concurrency: number;
  cache: false | { max: number };
  /** Whether the detector also reads image segments. */
  images?: boolean;
  /** Whether a label ends in a level, `:1` to `:3`, which `only` can filter by. */
  levels?: boolean;
  /**
   * Asks the provider about texts nobody has asked about yet. One list of hits per segment, in
   * order. Network calls go through `limit`, and stop when `signal` aborts. With `images`, it is
   * written as an `ImageAnalyze`.
   */
  analyze: Analyze;
}
