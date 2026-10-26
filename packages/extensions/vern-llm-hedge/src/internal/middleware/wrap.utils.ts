import { plan } from './plan.utils.js';
import { record, type Decision } from './record.utils.js';
import { sendHedges } from './sendHedges.utils.js';
import { settleRace } from './settleRace.utils.js';

import type { HedgeDeps } from './deps.js';
import type { CallResult, VernLLMMiddleware } from 'vern-llm';

type Wrap = NonNullable<VernLLMMiddleware['wrap']>;

/**
 * The `wrap` hook: plan, run the call, send the hedges that are due, and keep the first answer.
 * Every path ends in exactly one report, so a call has one decision.
 */
export function createWrap(deps: HedgeDeps): Wrap {
  const { guard, budget } = deps;

  return async (request, next, ctx) => {
    const callStart = Date.now();
    const report = (decision: Decision): void => record(ctx, guard, decision);

    // Runs the one chain as if the hedge were not there, and reports why once it settles. The
    // chain's own result or error passes through unchanged.
    const alone = (
      outcome: Decision['outcome'],
      chain: Promise<CallResult>,
      delayMs?: number,
    ): Promise<CallResult> =>
      chain.finally(() => report({ outcome, ...(delayMs !== undefined && { delayMs }) }));

    const chosen = plan(deps, request, ctx, next.again !== undefined, callStart);
    if (chosen.kind === 'skip') return alone(chosen.outcome, next(), chosen.delayMs);
    const { targets, first, delayMs } = chosen;

    // Eligible calls only, so skipped calls never build up a burst.
    budget.add();

    const main = next();
    const sent = await sendHedges(deps, ctx, next, main, targets, delayMs);
    if (sent.kind === 'alone') return alone(sent.outcome, main, delayMs);

    return settleRace(deps, ctx, report, sent.chains, targets, first, delayMs, callStart);
  };
}
