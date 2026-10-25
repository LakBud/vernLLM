import { isLLMError, type CallResult } from 'vern-llm';

import { guardLabelsKey } from '../../labels.js';
import { createFinish } from './finish.utils.js';
import { refuseStart, scanRequest } from './input.utils.js';
import { readOutput } from './output.utils.js';
import { cancelStream, joinParallel, startParallel } from './parallel.utils.js';

import type { GuardMiddleware } from '../../types/index.js';
import type { Live } from './live.js';

/** What runs around one call: scan the request, the call itself, then read the answer. */
export function createWrap(getLive: () => Live): NonNullable<GuardMiddleware['wrap']> {
  return async (request, next, ctx) => {
    // One reference for the whole call, so an update in the middle changes nothing for it.
    const live = getLive();
    const { compiled, memo, guard } = live;

    const started = await scanRequest(live, request, ctx);
    if ('error' in started) {
      guard.report('input scan', started.error);
      if (!compiled.failClosed) return next();
      throw refuseStart(live, ctx, started.error);
    }

    const { state, inputSegments, refusal } = started;
    const finish = createFinish(ctx, state);

    if (refusal !== undefined) {
      finish(true);
      throw refusal;
    }

    // Unknown labels are never stored: an absent key is what policy reads as unknown.
    if (state.labels !== undefined) ctx.state.set(guardLabelsKey, Object.freeze([...state.labels]));

    // Checks that run alongside the call start now and are joined once the call has answered.
    const reportParallel = (error: unknown): void => guard.report('parallel checks', error);
    // One that answers at once is joined here, so a block costs no provider call.
    const stop = new AbortController();
    let parallel = startParallel(compiled, inputSegments, state.cache, memo, ctx, stop.signal);
    if (parallel !== undefined && !(parallel instanceof Promise)) {
      const joined = await joinParallel(parallel, compiled, state.input, reportParallel);
      state.ms += joined.ms;
      if (joined.refusal !== undefined) {
        finish(true);
        throw joined.refusal;
      }
      parallel = undefined;
    }

    let result: CallResult;
    try {
      result = await next();
    } catch (error) {
      stop.abort();
      // A refusal from `transform` is this guard's own.
      finish(state.refused && isLLMError(error) && error.code === 'content_blocked');
      throw error;
    }

    if (parallel !== undefined) {
      const joined = await joinParallel(parallel, compiled, state.input, reportParallel);
      state.ms += joined.ms;
      const refusal = joined.refusal;
      if (refusal !== undefined) {
        cancelStream(result.value);
        finish(true);
        throw refusal;
      }
    }

    return readOutput(live, state, request, ctx, result, finish);
  };
}
