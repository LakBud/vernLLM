import type { ImageSegment, Segment } from '../types.js';

/**
 * One finding as it is remembered: a label and offsets, never the text. `unscanned` stands for a
 * segment that was not read, and has no label.
 */
export interface Span {
  readonly label?: string;
  readonly start?: number;
  readonly end?: number;
  readonly unscanned?: true;
}

/** What an answer is judged against: the source texts, and the question when there is one. */
export interface Ground {
  readonly sources: readonly string[];
  readonly query?: string;
}

/** An output text and the call it is judged against. Only the grounding view makes one. */
export interface GroundedSegment extends Segment {
  readonly ground: Ground;
}

/** Everything the hosted layer can be asked about. */
export type Input = Segment | ImageSegment | GroundedSegment;

/** A finding that always has a label, and offsets only when it can locate it. */
export type Hit = Span & { label: string };

/** Runs a task when one of the instance's slots is free. */
export type Limit = <T>(task: () => Promise<T>) => Promise<T>;

/** Asks the provider about texts, one list of hits per segment, in order. */
export type Analyze = (
  segments: readonly Input[],
  signal: AbortSignal,
  limit: Limit,
) => Promise<Span[][]>;

/** Findings remembered across calls, least recently used out first. */
export interface Memo {
  get(key: string): readonly Span[] | undefined;
  set(key: string, spans: readonly Span[]): void;
}
