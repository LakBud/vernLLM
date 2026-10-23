import { HEALTHY, type Signals } from './signals.js';

import type { DemotedTarget } from '../../types/index.js';
import type { OverReason } from './limits.utils.js';

export interface DemoteInput {
  order: readonly string[];
  signals: ReadonlyMap<string, Signals>;
  /** Targets over a soft limit or past the deadline, with why. */
  over?: ReadonlyMap<string, OverReason>;
  /** Whether open breakers and exhausted limits move targets back. Soft limits and warming apply either way. */
  health: boolean;
  rng: () => number;
}

type Group = 'healthy' | 'over' | 'limited' | 'open';

const signalOf = (signals: ReadonlyMap<string, Signals>, name: string): Signals =>
  signals.get(name) ?? HEALTHY;

/** open, then limited, then over a limit: the worst applicable group wins. */
function groupOf(input: DemoteInput, name: string): Group {
  const signal = signalOf(input.signals, name);
  if (input.health) {
    if (signal.circuit === 'open') return 'open';
    if (signal.limited) return 'limited';
  }
  return input.over?.has(name) ? 'over' : 'healthy';
}

/**
 * Moves targets back in fixed groups, each kept in its incoming order: healthy, over a limit or
 * past the deadline, limited, open. With no healthy target left the order is kept as is. A half
 * open target counts as healthy and keeps its place, so its trial runs. Then a target still
 * warming up after a recovery may give way once to the next healthy one.
 */
export function demote(input: DemoteInput): { order: string[]; demoted: DemotedTarget[] } {
  const { signals, rng } = input;
  let order = [...input.order];
  const demoted: DemotedTarget[] = [];

  const groups = new Map(order.map((name) => [name, groupOf(input, name)] as const));
  const inGroup = (group: Group): string[] => order.filter((name) => groups.get(name) === group);

  const healthy = inGroup('healthy');
  if (healthy.length > 0 && healthy.length < order.length) {
    const next = [...healthy, ...inGroup('over'), ...inGroup('limited'), ...inGroup('open')];

    // Only a target a healthy one overtook was moved back; one already behind them all stayed.
    const lastHealthy = Math.max(...healthy.map((name) => order.indexOf(name)));
    for (const group of ['over', 'limited', 'open'] as const) {
      for (const target of inGroup(group)) {
        if (order.indexOf(target) < lastHealthy) {
          // A target is in the over group only because `over` has it.
          const reason = group === 'over' ? (input.over?.get(target) as OverReason) : group;
          demoted.push({ target, reason });
        }
      }
    }
    order = next;
  }

  const first = order[0];
  if (first !== undefined) {
    const factor = signalOf(signals, first).warmingFactor;
    const replacement = order.findIndex(
      (name, index) => index > 0 && groups.get(name) === 'healthy',
    );
    if (factor < 1 && replacement > 0 && rng() < 1 - factor) {
      const [moved] = order.splice(replacement, 1);
      order = [moved as string, ...order];
      demoted.push({ target: first, reason: 'warming' });
    }
  }

  return { order, demoted };
}
