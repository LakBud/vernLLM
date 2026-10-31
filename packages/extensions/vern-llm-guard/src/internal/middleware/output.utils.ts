import {
  isStreamResult,
  type CallResult,
  type PreDispatchContext,
  type WireCallRequest,
} from 'vern-llm';

import { contentBlocked } from '../contentBlocked.utils.js';
import { errorName } from '../errors.utils.js';
import { gateOutput } from '../output/gate.js';
import { restoreOnly } from '../output/restoreOnly.utils.js';
import { gateStream } from '../output/streamGate.js';
import { callViewOf } from './callView.utils.js';
import { hasOutputWork, type CallState } from './state.js';

import type { Live } from './live.js';

/**
 * Reads the answer of a call that went through: a plain one is checked here, a stream as it
 * arrives. Resolves to what the caller gets, or throws the refusal.
 */
export async function readOutput(
  live: Live,
  state: CallState,
  request: WireCallRequest,
  ctx: PreDispatchContext,
  result: CallResult,
  finish: (blocked: boolean) => void,
): Promise<CallResult> {
  const { compiled, memo, guard } = live;

  // Read now, not before the call: a transform may have added a value to redact since.
  if (!hasOutputWork(state)) {
    finish(false);
    return result;
  }

  // A stream is checked as it arrives, and its one result is emitted when it settles. Its meta is
  // read then, since it is only known once the whole answer is.
  if (isStreamResult(result.value)) {
    const call = callViewOf(state, undefined);
    const gated = gateStream({
      compiled,
      source: result.value,
      tokens: state.tokens,
      cache: state.cache,
      deps: { memo, ctx, signal: ctx.signal, deadlineAt: ctx.deadlineAt, call },
      meta: () => result.meta,
      json: request.response_format !== undefined,
      marker: state.marker,
      onDone: (done) => {
        state.output = done.report;
        state.masked = done.masked;
        state.ms += done.ms;
        finish(done.blocked);
      },
    });
    return { ...result, value: gated };
  }

  let answer: Awaited<ReturnType<typeof gateOutput>>;
  try {
    answer = await gateOutput({
      compiled,
      value: result.value,
      tokens: state.tokens,
      cache: state.cache,
      deps: {
        memo,
        ctx,
        signal: ctx.signal,
        deadlineAt: ctx.deadlineAt,
        call: callViewOf(state, result.meta),
      },
      marker: state.marker,
    });
  } catch (error) {
    guard.report('output', error);
    if (!compiled.failClosed) {
      finish(false);
      // The checks could not run, but the caller must still not be handed a token.
      try {
        const restored = restoreOnly(result.value, state.tokens, state.marker);
        return restored === result.value ? result : { ...result, value: restored };
      } catch {
        return result;
      }
    }
    state.output = {
      checks: {},
      audit: {},
      errors: [{ name: errorName(error) }],
      late: 0,
      restored: 0,
      unrestored: 0,
    };
    finish(true);
    throw contentBlocked(compiled.version, 'output', undefined, [], true);
  }

  state.output = answer.report;
  state.masked = answer.masked;
  state.ms += answer.ms;

  if (answer.blocked !== undefined) {
    finish(true);
    throw contentBlocked(
      compiled.version,
      'output',
      answer.blocked.check,
      answer.blocked.label === undefined ? [] : [answer.blocked.label],
      answer.blocked.failed,
    );
  }

  finish(false);
  return answer.value === result.value ? result : { ...result, value: answer.value };
}
