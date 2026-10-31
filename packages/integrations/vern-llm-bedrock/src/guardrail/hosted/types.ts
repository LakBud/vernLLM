import type { Segment } from '../types.js';

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
