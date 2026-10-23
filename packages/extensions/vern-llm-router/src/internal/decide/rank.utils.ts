import { HEALTHY, type Signals } from './signals.js';

import type { RankMetric, ResolvedStrategy } from '../../types/index.js';

type RankStrategy = Extract<ResolvedStrategy, { type: 'rank' }>;

export interface RankInput {
  names: readonly string[];
  strategy: RankStrategy;
  signals: ReadonlyMap<string, Signals>;
  rng: () => number;
  /** Whether a target may be picked to explore: not open, not limited, within limits. */
  usable: (name: string) => boolean;
}

export interface RankResult {
  order: string[];
  /** Total score per target, lower is better. Empty when nothing was known. */
  scores: Map<string, number>;
  /** The target an exploration draw put first, when one did. */
  explored?: string;
}

/** The quality metric adds this to both sides, so a rate of 0 still has a finite ratio. */
const QUALITY_FLOOR = 0.01;
/** The most failures `effectiveCost` charges for, so one broken target is not infinitely dear. */
const MAX_QUALITY_FAILURE = 0.9;
const EPSILON = 1e-9;

const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

function rawValue(metric: RankMetric, signal: Signals): number | undefined {
  switch (metric) {
    case 'latency':
      return signal.latencyMs;
    case 'predictedLatency':
      return signal.predictedLatencyMs;
    case 'cost':
      return signal.costUsd;
    case 'effectiveCost': {
      if (!positive(signal.costUsd)) return undefined;
      const rate = Math.min(signal.qualityFailureRate ?? 0, MAX_QUALITY_FAILURE);
      return signal.costUsd / (1 - rate);
    }
    case 'quality': {
      const rate = signal.qualityFailureRate;
      return rate !== undefined && Number.isFinite(rate) && rate >= 0
        ? rate + QUALITY_FLOOR
        : undefined;
    }
    case 'custom':
      return signal.customValue;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Log ratio to the best value per target, unknowns at the median. `undefined`: nothing known. */
function metricScores(values: readonly (number | undefined)[]): number[] | undefined {
  const known = values.filter(positive);
  if (known.length === 0) return undefined;

  const best = Math.min(...known);
  const scores = values.map((value) => (positive(value) ? Math.log2(value / best) : undefined));
  const fill = median(scores.filter((score): score is number => score !== undefined));
  return scores.map((score) => score ?? fill);
}

/**
 * Orders one tier by the weighted sum of log scale metric scores, then picks first from the
 * targets near the best, or sometimes explores. Pure: draws come in through `rng`.
 */
export function rank(input: RankInput): RankResult {
  const { names, strategy, signals, rng } = input;
  const scores = new Map<string, number>();
  if (names.length < 2) return { order: [...names], scores };

  const signalOf = (name: string): Signals => signals.get(name) ?? HEALTHY;
  const columns: { weight: number; scores: number[] }[] = [];
  let rawMode = false;

  const onlyCustom = strategy.weights.size === 1 && strategy.weights.has('custom');
  if (onlyCustom) {
    // A lone custom metric that is not positive everywhere is used raw: any finite score works,
    // and only exact ties share first place.
    const values = names.map((name) => signalOf(name).customValue);
    if (values.some((value) => value !== undefined && Number.isFinite(value) && value <= 0)) {
      const finite = values.filter(
        (value): value is number => value !== undefined && Number.isFinite(value),
      );
      if (finite.length > 0) {
        const fill = median(finite);
        columns.push({ weight: 1, scores: values.map((value) => value ?? fill) });
        rawMode = true;
      }
    }
  }

  if (!rawMode) {
    for (const [metric, weight] of strategy.weights) {
      const column = metricScores(names.map((name) => rawValue(metric, signalOf(name))));
      if (column) columns.push({ weight, scores: column });
    }
  }
  if (columns.length === 0) return { order: [...names], scores };

  const totals = names.map((_, index) =>
    columns.reduce((sum, column) => sum + column.weight * (column.scores[index] as number), 0),
  );
  names.forEach((name, index) => scores.set(name, totals[index] as number));

  const best = Math.min(...totals);
  const cutoff = rawMode ? best : best + Math.log2(1 + strategy.tolerance);
  const group = names
    .map((_, index) => index)
    .filter((i) => (totals[i] as number) <= cutoff + EPSILON);

  let first: number | undefined;
  let explored: string | undefined;

  if (strategy.explore > 0 && rng() < strategy.explore) {
    const usable = names.filter((name) => input.usable(name));
    if (usable.length > 0) {
      explored = usable[Math.floor(rng() * usable.length)] as string;
      first = names.indexOf(explored);
    }
  }

  if (first === undefined) {
    if (group.length === 1) {
      first = group[0];
    } else {
      const weights = group.map((i) => 2 ** (-2 * ((totals[i] as number) - best)));
      let threshold = rng() * weights.reduce((sum, weight) => sum + weight, 0);
      first = group[group.length - 1];
      for (const [position, weight] of weights.entries()) {
        if (threshold < weight) {
          first = group[position];
          break;
        }
        threshold -= weight;
      }
    }
  }

  const rest = names
    .map((name, index) => ({ name, index, total: totals[index] as number }))
    .filter((entry) => entry.index !== first)
    .sort((a, b) => a.total - b.total || a.index - b.index)
    .map((entry) => entry.name);

  return { order: [names[first as number] as string, ...rest], scores, explored };
}
