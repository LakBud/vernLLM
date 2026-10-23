import { predictLatency } from './predictLatency.utils.js';

import type {
  CostSource,
  CustomMetric,
  HealthSource,
  RankMetric,
  ResolvedRoute,
  TargetSignals,
} from '../types/index.js';
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

/** Runs a source read, leaving the signal unknown on a throw and reporting each operation once. */
type Read = <T>(operation: string, fn: () => T) => T | undefined;

function createRead(guard: Guard): Read {
  const reported = new Set<string>();
  return (operation, fn) => {
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
}

/** Which signals this call's route can use, so nothing else is read. */
interface Needs {
  latency: boolean;
  predicted: boolean;
  cost: boolean;
  quality: boolean;
  custom: CustomMetric | undefined;
  q: number;
}

function needsOf(route: ResolvedRoute | undefined, hasDeadline: boolean): Needs {
  const strategy = route?.strategy.type === 'rank' ? route.strategy : undefined;
  const limits = route?.limits;
  const uses = (metric: RankMetric) => strategy?.weights.has(metric) === true;

  const predicted = uses('predictedLatency') || hasDeadline;
  return {
    predicted,
    latency: uses('latency') || predicted || limits?.latencyMs !== undefined || hasDeadline,
    cost: uses('cost') || uses('effectiveCost') || limits?.costUsd !== undefined,
    quality: uses('quality') || uses('effectiveCost') || limits?.qualityFailureRate !== undefined,
    custom: uses('custom') ? strategy?.custom : undefined,
    q: strategy?.q ?? DEFAULT_Q,
  };
}

/** What every per target read shares. */
interface Env {
  input: GatherInput;
  read: Read;
  needs: Needs;
  source: HealthSource | undefined;
}

/** A 429 cooldown, or a local rate limit used up for what this call needs. */
function readLimited(env: Env, target: TargetInfo, cooling: boolean): boolean {
  if (cooling || !env.source?.getRateLimitState) return cooling;
  const { source, read, input } = env;
  const levels = read('getRateLimitState', () =>
    source.getRateLimitState?.({ index: target.index }),
  );
  return (
    levels?.requestsRemaining === 0 ||
    (levels?.tokensRemaining !== undefined &&
      levels.tokensRemaining < input.facts.inputTokens + input.facts.maxTokens)
  );
}

function readLatency(env: Env, target: TargetInfo, signal: TargetSignals): void {
  const { input, read, needs } = env;
  const { stats, now } = input;
  if (!stats || !needs.latency) return;

  const latency = read('stats', () =>
    stats.quantile(
      { provider: target.name, streaming: String(input.streaming) },
      needs.q,
      'attemptMs',
      now,
    ),
  );
  if (latency !== undefined) signal.latencyMs = latency;

  if (needs.predicted) {
    const predicted =
      read('stats', () =>
        predictLatency(stats, target.name, input.route, input.request, needs.q, now),
      ) ?? latency;
    if (predicted !== undefined) signal.predictedLatencyMs = predicted;
  }
}

function readCost(env: Env, target: TargetInfo, signal: TargetSignals): void {
  const { input, read, needs } = env;
  const { cost } = input;
  if (!cost || !needs.cost) return;

  const price = read('cost', () => cost({ name: target.name, model: target.model }, input.request));
  if (price !== undefined) signal.costUsd = price;
}

/** The route's own failure rate, else the target's overall rate when the route has too few. */
function readQuality(env: Env, target: TargetInfo, signal: TargetSignals): void {
  const { input, read, needs } = env;
  const { stats, route, now } = input;
  // Only a route's strategy or limits ask for quality, so there is always a route here.
  if (!stats || !needs.quality || !route) return;

  const rate = read(
    'stats',
    () =>
      stats.failureRate({ provider: target.name, route: route.name }, now) ??
      stats.failureRate({ provider: target.name }, now),
  );
  if (rate !== undefined) signal.qualityFailureRate = rate;
}

/** Runs last, so the function sees every other signal of the target. */
function readCustom(env: Env, target: TargetInfo, signal: TargetSignals): void {
  const { input, read, needs } = env;
  const { custom } = needs;
  if (!custom) return;

  const value = read('custom', () =>
    custom(
      { name: target.name, model: target.model, adapter: target.adapter, signals: { ...signal } },
      { request: input.request, context: input.context, streaming: input.streaming },
    ),
  );
  if (typeof value === 'number') signal.customValue = value;
}

/**
 * Signals per target name, read synchronously, and only the ones this call can use. A read that
 * throws leaves that signal unknown, which `decide` treats as healthy or as the median, and is
 * reported once per operation for the call.
 */
export function gather(input: GatherInput): Map<string, Signals> {
  const read = createRead(input.guard);
  const source = read('health', () => input.health?.());
  const circuits = source ? read('getCircuitStates', () => source.getCircuitStates()) : undefined;
  const env: Env = {
    input,
    read,
    source,
    needs: needsOf(input.route, input.deadlineAt !== undefined),
  };

  const signals = new Map<string, Signals>();
  for (const target of input.targets) {
    const reading = input.state.read(target.name, input.now);
    const circuit = circuits?.find((entry) => entry.index === target.index)?.state;

    const signal: TargetSignals = {
      ...(circuit ? { circuit } : {}),
      limited: readLimited(env, target, reading.cooling),
      warmingFactor: reading.warmingFactor,
      inFlight: reading.inFlight,
    };
    readLatency(env, target, signal);
    readCost(env, target, signal);
    readQuality(env, target, signal);
    readCustom(env, target, signal);

    signals.set(target.name, signal);
  }
  return signals;
}
