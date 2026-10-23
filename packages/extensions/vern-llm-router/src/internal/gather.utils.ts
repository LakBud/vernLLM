import type { CostSource, HealthSource, ResolvedRoute, TargetSignals } from '../types/index.js';
import type { Signals } from './decide/signals.js';
import type { Guard } from './guard.utils.js';
import type { RequestFacts } from './match/requestFacts.utils.js';
import type { StatsCache } from './statsCache.js';
import type { TargetState } from './targetState.js';
import type { CallContext, TargetInfo, WireCallRequest } from 'vern-llm';

export interface GatherInput {
  targets: readonly TargetInfo[];
  /** The matched route, which decides what is worth reading. */
  route: ResolvedRoute | undefined;
  request: Readonly<WireCallRequest>;
  context: CallContext | undefined;
  streaming: boolean;
  deadlineAt: number | undefined;
  health: (() => HealthSource | undefined) | undefined;
  stats: StatsCache | undefined;
  cost: CostSource | undefined;
  state: TargetState;
  facts: RequestFacts;
  guard: Guard;
  now: number;
}

/** The quantile of `attemptMs` that limits and the deadline use when the route sets none. */
const DEFAULT_Q = 0.95;

/**
 * Signals per target name, read synchronously, and only the ones this call can use. A read that
 * throws leaves that signal unknown, which `decide` treats as healthy or as the median, and is
 * reported once per operation for the call.
 */
export function gather(input: GatherInput): Map<string, Signals> {
  const { targets, route, request, state, facts, guard, now } = input;

  const reported = new Set<string>();
  const read = <T>(operation: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      if (!reported.has(operation)) {
        reported.add(operation);
        guard.report(operation, error);
      }
      return undefined;
    }
  };

  const source = read('health', () => input.health?.());
  const circuits = source ? read('getCircuitStates', () => source.getCircuitStates()) : undefined;

  const strategy = route?.strategy.type === 'rank' ? route.strategy : undefined;
  const limits = route?.limits;
  const uses = (
    metric: 'latency' | 'predictedLatency' | 'cost' | 'effectiveCost' | 'quality' | 'custom',
  ) => strategy?.weights.has(metric) === true;
  const deadline = input.deadlineAt !== undefined;

  const needPredicted = uses('predictedLatency') || deadline;
  const needLatency =
    uses('latency') || needPredicted || limits?.latencyMs !== undefined || deadline;
  const needCost = uses('cost') || uses('effectiveCost') || limits?.costUsd !== undefined;
  const needQuality =
    uses('quality') || uses('effectiveCost') || limits?.qualityFailureRate !== undefined;
  const q = strategy?.q ?? DEFAULT_Q;
  const stats = input.stats;

  const signals = new Map<string, Signals>();
  for (const target of targets) {
    const reading = state.read(target.name, now);
    const circuit = circuits?.find((entry) => entry.index === target.index)?.state;

    let limited = reading.cooling;
    if (!limited && source?.getRateLimitState) {
      const levels = read('getRateLimitState', () =>
        source.getRateLimitState?.({ index: target.index }),
      );
      limited =
        levels?.requestsRemaining === 0 ||
        (levels?.tokensRemaining !== undefined &&
          levels.tokensRemaining < facts.inputTokens + facts.maxTokens);
    }

    const signal: TargetSignals = {
      ...(circuit ? { circuit } : {}),
      limited,
      warmingFactor: reading.warmingFactor,
      inFlight: reading.inFlight,
    };

    if (stats && needLatency) {
      const latency = read('stats', () =>
        stats.quantile(
          { provider: target.name, streaming: String(input.streaming) },
          q,
          'attemptMs',
          now,
        ),
      );
      if (latency !== undefined) signal.latencyMs = latency;

      if (needPredicted) {
        signal.predictedLatencyMs =
          read('stats', () => predictLatency(stats, target.name, route, request, q, now)) ??
          latency;
        if (signal.predictedLatencyMs === undefined) delete signal.predictedLatencyMs;
      }
    }

    if (input.cost && needCost) {
      const price = read('cost', () =>
        input.cost?.({ name: target.name, model: target.model }, request),
      );
      if (price !== undefined) signal.costUsd = price;
    }

    if (stats && needQuality) {
      const rate = read('stats', () => {
        const byRoute = route
          ? stats.failureRate({ provider: target.name, route: route.name }, now)
          : undefined;
        return byRoute ?? stats.failureRate({ provider: target.name }, now);
      });
      if (rate !== undefined) signal.qualityFailureRate = rate;
    }

    if (strategy?.custom && uses('custom')) {
      const custom = strategy.custom;
      const value = read('custom', () =>
        custom(
          {
            name: target.name,
            model: target.model,
            adapter: target.adapter,
            signals: { ...signal },
          },
          { request, context: input.context, streaming: input.streaming },
        ),
      );
      if (typeof value === 'number') signal.customValue = value;
    }

    signals.set(target.name, signal);
  }
  return signals;
}

/** The slow tail of generation speed, as the complementary quantile without float noise. */
const slowTail = (q: number): number => Math.round((1 - q) * 1e6) / 1e6;

/**
 * Time to first token plus the expected answer at the target's generation speed. Streamed data is
 * used for every call, since how a provider starts and generates does not depend on delivery.
 * `undefined` when there is no streamed start or speed, so the caller falls back to plain latency.
 */
function predictLatency(
  stats: StatsCache,
  name: string,
  route: ResolvedRoute | undefined,
  request: Readonly<WireCallRequest>,
  q: number,
  now: number,
): number | undefined {
  const streamed = { provider: name, streaming: 'true' };
  const start = stats.quantile(streamed, q, 'attemptMs', now);
  const speed = stats.quantile(streamed, slowTail(q), 'outputTokensPerSec', now);
  if (start === undefined || speed === undefined || !(speed > 0)) return undefined;

  const typical = route
    ? stats.quantile({ route: route.name }, 0.5, 'outputTokens', now)
    : undefined;
  const expected = Math.min(
    typical !== undefined && typical > 0 ? typical : request.max_tokens,
    request.max_tokens,
  );
  return start + (expected / speed) * 1000;
}
