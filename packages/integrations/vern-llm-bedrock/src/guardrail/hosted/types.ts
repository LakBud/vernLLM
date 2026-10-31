import type { Segment } from '../types.js';

// This folder is the shared part of a hosted detector: views by kind, one request per text, a cache
// and a limit on requests in flight. Hosted detectors elsewhere in this repo use the same design
// and keep their own copy, since packages don't import each other. Keep the copies in step.

/** One finding as it is remembered: a label and offsets, never the text. */
export interface Span {
  readonly label?: string;
  readonly start?: number;
  readonly end?: number;
}

/** A finding that always has a label, and offsets only when it can locate it. */
export type Hit = Span & { label: string };

/** Runs a task when one of the instance's slots is free. */
export type Limit = <T>(task: () => Promise<T>) => Promise<T>;

/** Asks the provider about texts, one list of hits per segment, in order. */
export type Analyze = (
  segments: readonly Segment[],
  signal: AbortSignal,
  limit: Limit,
) => Promise<Hit[][]>;

/** Findings remembered across calls, least recently used out first. */
export interface Memo {
  get(key: string): readonly Span[] | undefined;
  set(key: string, spans: readonly Span[]): void;
}
