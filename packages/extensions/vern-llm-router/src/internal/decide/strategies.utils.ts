import { rank } from './rank.utils.js';
import { HEALTHY, type Signals } from './signals.js';

import type { ResolvedStrategy } from '../../types/index.js';

export interface StrategyInput {
  /** One tier's targets, in the order they should win ties. */
  names: readonly string[];
  strategy: ResolvedStrategy;
  signals: ReadonlyMap<string, Signals>;
  rng: () => number;
  /** A number in `[0, 1)` from the call's `stickyBy` value, standing in for a draw. */
  stickyUnit?: number;
  /** Whether a target may be picked to explore. Only `rank` explores. */
  usable: (name: string) => boolean;
}

export interface TierResult {
  order: string[];
  scores?: Map<string, number>;
  explored?: string;
}

const weightOf = (weights: ReadonlyMap<string, number> | undefined, name: string): number =>
  weights?.get(name) ?? 1;

/** Index of the weighted pick for a draw `u` in `[0, 1)`; the first index when all weights are 0. */
function pickIndex(weights: readonly number[], u: number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return 0;

  let threshold = u * total;
  for (const [index, weight] of weights.entries()) {
    if (threshold < weight) return index;
    threshold -= weight;
  }
  return weights.length - 1;
}

function weighted(
  input: StrategyInput,
  strategy: ResolvedStrategy & { type: 'weighted' },
): string[] {
  const { names } = input;
  const weights = names.map((name) => weightOf(strategy.weights, name));
  const first = pickIndex(weights, input.stickyUnit ?? input.rng());

  const rest = names
    .map((name, index) => ({ name, index, weight: weights[index] as number }))
    .filter((entry) => entry.index !== first)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.name);
  return [names[first] as string, ...rest];
}

function leastBusy(
  input: StrategyInput,
  strategy: ResolvedStrategy & { type: 'least-busy' },
): string[] {
  const { names, signals } = input;
  if (names.length < 2) return [...names];

  const weights = names.map((name) => weightOf(strategy.weights, name));
  const inFlight = (name: string): number => (signals.get(name) ?? HEALTHY).inFlight;

  // Two distinct samples, the second drawn from what the first left.
  const a = pickIndex(weights, input.rng());
  const others = names.map((_, index) => index).filter((index) => index !== a);
  const b = others[
    pickIndex(
      others.map((index) => weights[index] as number),
      input.rng(),
    )
  ] as number;

  // Load per unit of weight; a weight of 0 can only win when the other is also 0.
  const load = (index: number): number => {
    const weight = weights[index] as number;
    return weight > 0 ? inFlight(names[index] as string) / weight : Number.POSITIVE_INFINITY;
  };
  const winner = load(a) < load(b) ? a : load(b) < load(a) ? b : Math.min(a, b);

  const rest = names
    .map((name, index) => ({ name, index }))
    .filter((entry) => entry.index !== winner)
    .sort((x, y) => inFlight(x.name) - inFlight(y.name) || x.index - y.index)
    .map((entry) => entry.name);
  return [names[winner] as string, ...rest];
}

/** Orders one tier. Pure: randomness comes in through `rng` and `stickyUnit`. */
export function orderTier(input: StrategyInput): TierResult {
  const { strategy } = input;
  if (strategy.type === 'weighted') return { order: weighted(input, strategy) };
  if (strategy.type === 'least-busy') return { order: leastBusy(input, strategy) };
  if (strategy.type === 'rank') {
    return rank({
      names: input.names,
      strategy,
      signals: input.signals,
      rng: input.rng,
      usable: input.usable,
    });
  }
  return { order: [...input.names] };
}
