import type { Detector, Segment } from '../../types/index.js';
import type { Span } from '../scan/types.js';
import type { Limit } from './limit.js';

/** A finding of a hosted detector: it always has a label, and offsets only when it can locate it. */
export type Hit = Span & { label: string };

/** A detector, and the same detector narrowed to some kinds of finding. */
export type HostedDetector<Kind extends string> = Detector & {
  /** Another detector over the same requests and cache, returning only these kinds. */
  only(...kinds: Kind[]): Detector;
};

/** Asks the provider about texts, one list of hits per segment, in order. */
export type Analyze = (
  segments: readonly Segment[],
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
  /**
   * Asks the provider about texts nobody has asked about yet. One list of hits per segment, in
   * order. Network calls go through `limit`, and stop when `signal` aborts.
   */
  analyze: Analyze;
}
