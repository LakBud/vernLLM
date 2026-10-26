import { raceDelay } from '../race.utils.js';

import type { HedgeDeps } from './deps.js';
import type { Decision } from './record.utils.js';
import type { CallResult, PreDispatchContext, WrapNext } from 'vern-llm';

/** Chains to race, or why the main chain alone is kept. */
export type Sent =
  | { kind: 'alone'; outcome: Decision['outcome'] }
  | { kind: 'raced'; chains: Promise<CallResult>[] };

/** Settles when the chain answers, and never when it fails. */
const untilAnswered = (chain: Promise<CallResult>): Promise<unknown> =>
  chain.catch(() => new Promise<never>(() => {}));

/**
 * One iteration per hedge. The first waits for the delay the main chain has been running; each
 * later one waits another delay, and none is sent once a chain has settled.
 */
export async function sendHedges(
  { config, budget }: HedgeDeps,
  ctx: PreDispatchContext,
  next: WrapNext,
  main: Promise<CallResult>,
  targets: readonly string[],
  delayMs: number,
): Promise<Sent> {
  const chains: Promise<CallResult>[] = [main];
  let anySettled: Promise<unknown> = main;

  for (let hedge = 1; hedge <= config.maxHedges; hedge++) {
    if ((await raceDelay(anySettled, delayMs, ctx.signal)) === 'settled') {
      if (hedge > 1) break;
      return { kind: 'alone', outcome: await whyAlone(ctx, main) };
    }

    // Each hedge goes one name further along `targets` and keeps the rest as its fallback.
    const rest = targets.slice(hedge - 1);
    if (rest.length === 0) break;

    // Read again: other layers may have used up the call's reruns while the delay ran.
    const again = next.again;
    if (!again) {
      if (hedge === 1) return { kind: 'alone', outcome: 'unavailable' };
      break;
    }

    // The token is taken when the delay passes, so calls that answer in time cost nothing.
    if (!budget.take()) {
      if (hedge === 1) return { kind: 'alone', outcome: 'budget' };
      break;
    }

    let sent: Promise<CallResult>;
    try {
      sent = again({ targets: rest });
    } catch (error) {
      budget.refund();
      sent = Promise.reject(error);
    }
    chains.push(sent);
    // A hedge that fails is not a reason to stop: only the main chain settling, or any chain
    // answering, ends the wait.
    if (hedge < config.maxHedges) {
      anySettled = Promise.race([main, ...chains.slice(1).map(untilAnswered)]);
    }
  }

  return { kind: 'raced', chains };
}

/** Why the main chain ended before the delay did. */
async function whyAlone(
  ctx: PreDispatchContext,
  main: Promise<CallResult>,
): Promise<Decision['outcome']> {
  if (ctx.signal?.aborted) return 'aborted';
  return main.then(
    () => 'not_needed' as const,
    () => 'failed' as const,
  );
}
