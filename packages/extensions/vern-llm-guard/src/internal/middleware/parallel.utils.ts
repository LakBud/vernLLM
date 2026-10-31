import { isStreamResult, type LLMError, type PreDispatchContext } from 'vern-llm';

import { contentBlocked } from '../contentBlocked.utils.js';
import { errorName } from '../errors.utils.js';
import { scan } from '../scan/scan.js';

import type { PhaseReport } from '../../types/index.js';
import type { CompiledChecks } from '../../types/resolvedConfig.js';
import type { CallCache, Memo, ScanResult } from '../scan/types.js';
import type { InputSegment } from '../segments/types.js';

/** How a check that runs alongside the call ended: its scan, or the guard failing around it. */
export type ParallelOutcome = ScanResult | { error: unknown };

const noop = (): void => {};

/**
 * Starts the checks marked `parallel` over the request the call was made with. Returns `undefined`
 * when there are none. `stop` ends them when the call fails before they are joined.
 */
export function startParallel(
  compiled: CompiledChecks,
  segments: readonly InputSegment[],
  cache: CallCache,
  memo: Memo | undefined,
  ctx: PreDispatchContext,
  stop: AbortSignal,
  covered?: Set<number>,
): ParallelOutcome | Promise<ScanResult> | undefined {
  if (compiled.parallel.length === 0) return undefined;

  const only = new Set(compiled.parallel.map((check) => check.id));
  const signal = ctx.signal === undefined ? stop : AbortSignal.any([ctx.signal, stop]);

  try {
    return scan(compiled, segments, cache, {
      memo,
      ctx,
      signal,
      deadlineAt: ctx.deadlineAt,
      only,
      covered,
    });
  } catch (error) {
    return { error };
  }
}

/**
 * Waits for the parallel checks and adds what they found to the input report. Returns the refusal
 * when one of them blocks, or could not answer and the guard fails closed.
 */
export async function joinParallel(
  parallel: ParallelOutcome | Promise<ScanResult>,
  compiled: CompiledChecks,
  input: PhaseReport,
  onFailure: (error: unknown) => void,
): Promise<{ refusal: LLMError | undefined; ms: number }> {
  const done = await parallel;

  if ('error' in done) {
    onFailure(done.error);
    input.errors.push({ name: errorName(done.error) });
    return {
      refusal: compiled.failClosed
        ? contentBlocked(compiled.version, 'input', undefined, [], true)
        : undefined,
      ms: 0,
    };
  }

  Object.assign(input.checks, done.report.checks);
  Object.assign(input.audit, done.report.audit);
  input.errors.push(...done.report.errors);

  return {
    refusal:
      done.blocked === undefined
        ? undefined
        : contentBlocked(
            compiled.version,
            'input',
            done.blocked.check,
            done.blocked.label === undefined ? [] : [done.blocked.label],
            done.blocked.failed,
          ),
    ms: done.ms,
  };
}

/** Ends a stream the caller will never see: its provider call is cancelled, not left to run. */
export function cancelStream(value: unknown): void {
  if (!isStreamResult(value)) return;

  value.finalResult.catch(noop);
  const iterator = value.chunks[Symbol.asyncIterator]();
  // Pulling one chunk starts the stream, so leaving it reaches the provider call.
  iterator
    .next()
    .then(() => iterator.return?.(), noop)
    .catch(noop);
}
