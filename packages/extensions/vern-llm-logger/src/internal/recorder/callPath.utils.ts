import { elapsedMs, nowMs } from '../clock.utils.js';
import { errorCodeOf, lastAttemptErrorOf } from './outcome.utils.js';
import { roundMs } from './recordMetrics.utils.js';

import type { PathEntry } from '../../types/index.js';
import type { AttemptContext } from 'vern-llm';

/** One target tried during the call. Mutable until the target is left or the call ends. */
export interface PathState {
  provider: string;
  model: string;
  attempts: number;
  startedAtMs: number;
  closed: boolean;
  outcome: PathEntry['outcome'];
  elapsedMs: number;
  errorCode: string | undefined;
}

/** The attempt whose outcome is not known yet. */
export interface OpenAttempt {
  startedAtMs: number;
  /** When `dispatch` resolved. Parsing and validation may still fail after it. */
  respondedAtMs: number | undefined;
  path: PathState;
}

/** Counts one more attempt on the current target, or starts a new entry for a new target. */
export function enterTarget(path: PathState[], ctx: AttemptContext): PathState {
  let entry = path[path.length - 1];
  if (!entry || entry.closed || entry.provider !== ctx.requestedProvider) {
    entry = {
      provider: ctx.requestedProvider,
      model: ctx.requestedModel,
      attempts: 0,
      startedAtMs: nowMs(),
      closed: false,
      outcome: 'error',
      elapsedMs: 0,
      errorCode: undefined,
    };
    path.push(entry);
  }
  entry.attempts++;
  return entry;
}

/** Takes back an attempt that never reached a provider, and its entry if it was the only one. */
export function leaveTarget(path: PathState[], attempt: OpenAttempt): void {
  attempt.path.attempts--;
  if (attempt.path.attempts !== 0) return;

  const index = path.indexOf(attempt.path);
  // The entry was pushed by `openAttempt`, so it is always found.
  /* v8 ignore next */
  if (index !== -1) path.splice(index, 1);
}

/** The call moves on: the last target is finished as failed. */
export function closeTargetAsFailed(
  path: readonly PathState[],
  elapsedMsOnTarget: number,
  error: unknown,
): void {
  const entry = path[path.length - 1];
  if (!entry || entry.closed) return;

  entry.closed = true;
  entry.outcome = 'error';
  entry.errorCode = errorCodeOf(error);
  // The core's own figure, measured here only if it is missing.
  entry.elapsedMs =
    Number.isFinite(elapsedMsOnTarget) && elapsedMsOnTarget >= 0
      ? elapsedMsOnTarget
      : elapsedMs(entry.startedAtMs);
}

/** The call ends: the last target, if still open, answered or failed as the call did. */
export function closeLastTarget(
  path: readonly PathState[],
  endedAtMs: number,
  failure: { failed: boolean; error: unknown },
): void {
  const last = path[path.length - 1];
  if (!last || last.closed) return;

  last.closed = true;
  last.elapsedMs = elapsedMs(last.startedAtMs, endedAtMs);
  if (failure.failed) {
    last.outcome = 'error';
    last.errorCode = errorCodeOf(lastAttemptErrorOf(failure.error));
  } else {
    last.outcome = 'ok';
  }
}

export function pathEntryOf(entry: PathState): PathEntry {
  const result: PathEntry = {
    provider: entry.provider,
    model: entry.model,
    attempts: entry.attempts,
    outcome: entry.outcome,
    elapsedMs: roundMs(entry.elapsedMs),
  };
  if (entry.errorCode !== undefined) result.errorCode = entry.errorCode;
  return result;
}
