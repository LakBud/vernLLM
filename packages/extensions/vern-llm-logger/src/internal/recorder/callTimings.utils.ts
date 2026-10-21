import { elapsedMs } from '../clock.utils.js';

import type { OpenAttempt } from './callPath.utils.js';

export interface CallTimings {
  /** How long the answering attempt took to respond. */
  attemptMs: number | undefined;
  /** The window the output tokens were produced in. */
  generationMs: number | undefined;
  /** Call start to first content chunk, streams only. */
  ttftMs: number | undefined;
}

/**
 * The token rate of a stream is the generation window after its first chunk, not the wait
 * before it. That wait is `ttftMs`, measured from the call's start.
 */
export function timingsOf(input: {
  open: OpenAttempt | undefined;
  answered: boolean;
  streaming: boolean;
  startedAtMs: number;
  endedAtMs: number;
}): CallTimings {
  const { open, answered, streaming, startedAtMs, endedAtMs } = input;
  const respondedAtMs = open?.respondedAtMs;

  let attemptMs: number | undefined;
  let generationMs: number | undefined;
  if (open && answered) {
    attemptMs = elapsedMs(open.startedAtMs, respondedAtMs ?? endedAtMs);
    generationMs = streaming ? elapsedMs(respondedAtMs ?? endedAtMs, endedAtMs) : attemptMs;
  }
  const ttftMs =
    streaming && respondedAtMs !== undefined ? elapsedMs(startedAtMs, respondedAtMs) : undefined;

  return { attemptMs, generationMs, ttftMs };
}
