import { HEDGE_ADAPT_EVENT } from '../../events.js';
import { firstSuccess, type Raced } from '../race.utils.js';
import { hedgesOf, type Decision } from './record.utils.js';

import type { HedgeDeps } from './deps.js';
import type { CallResult, JsonValue, PreDispatchContext } from 'vern-llm';

/**
 * Keeps the first chain to succeed, counts the call for the win rate, and reports it. When every
 * chain failed, the main chain's error is thrown, as if no hedge had been sent.
 */
export async function settleRace(
  { adapt, guard }: HedgeDeps,
  ctx: PreDispatchContext,
  report: (decision: Decision) => void,
  chains: readonly Promise<CallResult>[],
  targets: readonly string[],
  first: string,
  delayMs: number,
  callStart: number,
): Promise<CallResult> {
  const sentCount = chains.length - 1;
  let raced: Raced;
  try {
    raced = await firstSuccess(chains);
  } catch (error) {
    report({ outcome: 'lost', delayMs, target: targets[0], ...hedgesOf(sentCount) });
    throw error;
  }

  // A call where every chain failed says nothing about whether the hedge helps, so only calls
  // that were answered count.
  const adapted = adapt?.record(first, raced.winner > 0, Date.now());
  if (adapted) {
    guard('adapt', () => ctx.emit(HEDGE_ADAPT_EVENT, adapted as unknown as JsonValue), undefined);
  }

  report({
    outcome: raced.winner > 0 ? 'won' : 'lost',
    delayMs,
    target: targets[0],
    ms: Date.now() - callStart,
    ...hedgesOf(sentCount),
    // The winning hedge's first target; its fallback may be the one that answered.
    ...(sentCount > 1 && raced.winner > 0 && { winner: targets[raced.winner - 1] }),
  });
  // Unchanged, so the core finds the chain it came from and cancels the others.
  return raced.result;
}
