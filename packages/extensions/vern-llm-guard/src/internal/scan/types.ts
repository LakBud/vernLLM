import type { CallView, CheckContext, PhaseReport } from '../../types/index.js';
import type { CompiledCheck } from '../../types/resolvedConfig.js';

/** One finding as it is remembered: offsets and a kind, never the text. */
export interface Span {
  readonly label?: string;
  readonly start?: number;
  readonly end?: number;
  /** The detector did not read this segment. It is remembered, since asking again gives the same. */
  readonly unscanned?: true;
}

/** What one call already knows, keyed by check and text. It lives in `ctx.own`. */
export type CallCache = Map<string, readonly Span[]>;

export interface ScanDeps {
  memo: Memo | undefined;
  /**
   * Read the memo but never write to it. A stream scans a growing buffer, and every prefix would
   * become an entry of its own and push out the ones worth keeping.
   */
  memoReadOnly?: boolean | undefined;
  /** What a check's `when` reads. */
  ctx: CheckContext;
  /** The call's own signal. */
  signal?: AbortSignal | undefined;
  /** When the call's deadline runs out, as epoch milliseconds. */
  deadlineAt?: number | undefined;
  /**
   * Findings to leave out, by segment index, span and the check that found it. How the output gate
   * skips a token that stands for something the user sent. A finding without offsets is skipped
   * only when the callback says so for its check.
   */
  skip?: ((segment: number, span: Span, check: CompiledCheck) => boolean) | undefined;
  /** Run only these checks, by id. A stream uses it to leave out checks that wait for a window. */
  only?: ReadonlySet<string> | undefined;
  /** What a check with `callView: true` is given, as its third argument. Output scans only. */
  call?: CallView | undefined;
  /**
   * Image segments, by index, that some check took and read. The caller counts the rest as
   * unscanned. Shared between scans, since the checks of one call can run in two.
   */
  covered?: Set<number> | undefined;
}

/** One finding of an enforced check, in the numbering of the segments that were scanned. */
export interface ScanFinding {
  check: CompiledCheck;
  segment: number;
  span: Span;
}

export interface ScanResult {
  /** What policy sees, in check order. Not meaningful when `unknown`. */
  labels: string[];
  /** A check that labels could not answer, so the labels cannot be trusted. */
  unknown: boolean;
  /** Set when the call must be refused: the check that fired first, or that could not answer. */
  blocked?: { check: string; label?: string; failed: boolean };
  /** What enforced checks found, with offsets. Audit checks are not here. */
  findings: ScanFinding[];
  /** How many of those were in text that no earlier scan of this call had read. */
  fresh: number;
  /** Ids of the checks whose detector answered with a promise. */
  slow: string[];
  report: PhaseReport;
  /** Wall time of the whole scan, in milliseconds. */
  ms: number;
}

/** Findings remembered across calls, least recently used out first. */
export interface Memo {
  get(key: string): readonly Span[] | undefined;
  set(key: string, spans: readonly Span[]): void;
  readonly size: number;
}
