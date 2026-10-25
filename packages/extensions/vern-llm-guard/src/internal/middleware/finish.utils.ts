import { GUARD_RESULT_EVENT } from '../../events.js';
import { guardSummaryKey } from '../../labels.js';

import type { GuardOutcome, GuardResult } from '../../types/index.js';
import type { CallState } from './state.js';
import type { JsonValue, PreDispatchContext } from 'vern-llm';

/** How the call ended, from the most to the least serious. */
function outcomeOf(state: CallState, blocked: boolean): GuardOutcome {
  if (blocked) return 'blocked';
  if (state.redacted > 0 || state.masked > 0) return 'redacted';
  if (state.labels !== undefined && state.labels.length > 0) return 'labeled';
  return 'passed';
}

/** Makes the function that emits the one result of a call. */
export function createFinish(
  ctx: PreDispatchContext,
  state: CallState,
): (blocked: boolean) => void {
  return (blocked) => {
    const outcome = outcomeOf(state, blocked);

    const result: GuardResult = {
      v: 1,
      version: state.compiled.version,
      outcome,
      ...(state.labels !== undefined && { labels: [...state.labels] }),
      input: state.input,
      ...(state.output !== undefined && { output: state.output }),
    };
    ctx.emit(GUARD_RESULT_EVENT, result as unknown as JsonValue);
    ctx.state.set(guardSummaryKey, {
      outcome,
      ...(state.labels !== undefined && { labels: state.labels }),
      ms: Math.round(state.ms * 100) / 100,
    });
  };
}
