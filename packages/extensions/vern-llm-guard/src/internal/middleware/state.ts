import type { OutputReport, PhaseReport, Segment } from '../../types/index.js';
import type { CompiledCheck, CompiledChecks } from '../../types/resolvedConfig.js';
import type { CallCache, Memo } from '../scan/types.js';
import type { TokenMap } from '../tokens/tokens.js';
import type { AttemptContext } from 'vern-llm';

/** The key of this guard's state in `ctx.own`, shared by `wrap` and every `transform` of a call. */
export const STATE = 'state';

/** What `wrap` and the `transform` of each attempt share for one call. */
export interface CallState {
  compiled: CompiledChecks;
  memo: Memo | undefined;
  cache: CallCache;
  tokens: TokenMap;
  /** The request's text as the caller sent it, which an output check with `call` reads. */
  inputText: readonly Segment[];
  labels: readonly string[] | undefined;
  input: PhaseReport;
  output?: OutputReport;
  /** Time spent in checks, in milliseconds. */
  ms: number;
  /** The spotlight marker of this version, when spotlight is on. */
  marker: string | undefined;
  /** Whether the request has text the marker will be put in, so an answer may echo it. */
  marked: boolean;
  /** Values replaced by tokens, across attempts. */
  redacted: number;
  /** Values an output check masked. */
  masked: number;
  /** Set when this guard refused the call from `transform`. */
  refused: boolean;
}

export function redactsFor(check: CompiledCheck, ctx: AttemptContext): boolean {
  if (check.redactFor === undefined) return true;
  try {
    return check.redactFor(ctx) !== false;
  } catch {
    // When it cannot be decided, the safe answer is to redact.
    return true;
  }
}

/** Whether the answer has to be read: a value to restore, or an enforced check on it. */
export const hasOutputWork = (state: CallState): boolean =>
  state.tokens.entries.size > 0 ||
  state.marked ||
  state.compiled.checks.some((check) => check.sources.has('output'));
