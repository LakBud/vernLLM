import type { AdaptEvent, ResolvedAdapt } from '../types/index.js';

interface TargetState {
  /** The last `window` hedged calls of this first target: whether the hedge won. */
  results: boolean[];
  /** Added to the base quantile. */
  boost: number;
  pausedUntil: number;
  /** Whether `slow` was reported, until the win rate falls back. */
  slow: boolean;
  /** Hedged calls since `slow` was last reported, still above the high win rate. */
  sinceSlow: number;
}

/**
 * Watches how often a first target's hedges win, and answers in two ways. Rarely winning means
 * the delay is too short for that target: wait for a higher quantile, then stop hedging it for a
 * while. Often winning means the first target is the problem, which is reported, and again every
 * `minHedges` hedged calls while it stays so.
 */
export class Adapt {
  private readonly targets = new Map<string, TargetState>();

  /**
   * @param baseQuantile the configured quantile, or `undefined` when the delay is a number or a
   * function, which has no quantile to raise.
   */
  constructor(
    private readonly config: ResolvedAdapt,
    private readonly baseQuantile: number | undefined,
  ) {}

  /** Whether this target is out of hedging for now. */
  paused(target: string, now: number): boolean {
    return now < (this.targets.get(target)?.pausedUntil ?? 0);
  }

  /** The quantile to wait for on this target: the base, raised by what the win rate asked for. */
  quantileFor(target: string, base: number): number {
    const boost = this.targets.get(target)?.boost ?? 0;
    return Math.min(base + boost, this.ceiling(base));
  }

  /** The highest quantile a target may be raised to, never below the one configured. */
  private ceiling(base: number): number {
    return Math.max(base, this.config.maxQuantile);
  }

  /** Counts a hedged call. Returns the one change it caused, if any. */
  record(target: string, won: boolean, now: number): AdaptEvent | undefined {
    let state = this.targets.get(target);
    if (!state) {
      state = { results: [], boost: 0, pausedUntil: 0, slow: false, sinceSlow: 0 };
      this.targets.set(target, state);
    }

    state.results.push(won);
    if (state.results.length > this.config.window) state.results.shift();
    if (state.results.length < this.config.minHedges) return undefined;

    const hedges = state.results.length;
    const winRate = state.results.filter(Boolean).length / hedges;

    if (winRate < this.config.lowWinRate) {
      state.slow = false;
      state.results = [];

      const base = this.baseQuantile;
      // The quantile after one more step, held at the configured ceiling. With nothing to raise,
      // or no room left, stop hedging this target for a while and start over afterwards.
      const next =
        base === undefined
          ? undefined
          : Math.min(base + state.boost + this.config.quantileStep, this.ceiling(base));
      if (base === undefined || next === undefined || next <= base + state.boost) {
        state.boost = 0;
        state.pausedUntil = now + this.config.pauseMs;
        return { action: 'pause', target, winRate, hedges };
      }

      state.boost = next - base;
      return { action: 'raise_quantile', target, winRate, hedges, quantile: next };
    }

    if (winRate > this.config.highWinRate) {
      // Reported again every `minHedges` hedged calls while it lasts, since whoever listens may
      // hold the target back only for a while, and the target is first again once that ends.
      if (state.slow && ++state.sinceSlow < this.config.minHedges) return undefined;
      state.slow = true;
      state.sinceSlow = 0;
      return { action: 'slow', target, winRate, hedges };
    }

    state.slow = false;
    return undefined;
  }
}
