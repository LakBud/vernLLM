import type { CircuitStateName } from './sources.js';
import type { AdapterInfo, CallContext, WireCallRequest } from 'vern-llm';

/** What the router knows about one target when it decides. A field is absent when unknown. */
export interface TargetSignals {
  circuit?: CircuitStateName;
  /** A local rate limit is used up, or a provider 429 cooldown is still running. */
  limited: boolean;
  /** `1`, or `0.1` to `1` while ramping up after the breaker closed. */
  warmingFactor: number;
  /** Attempts the router has seen start and not yet finish on this target. */
  inFlight: number;
  /** p`q` of `attemptMs` for this target and `streaming`. */
  latencyMs?: number;
  /** Time to first token plus this request's expected answer at the target's generation speed. */
  predictedLatencyMs?: number;
  /** What the request could cost on this target, in USD. */
  costUsd?: number;
  /** Share of this route's responded attempts rejected as unusable, else the target's overall share. */
  qualityFailureRate?: number;
  /** What a `custom` function returned for this target. */
  customValue?: number;
}

/** The target a `custom` metric scores. */
export interface CustomCandidate {
  name: string;
  model: string;
  adapter: AdapterInfo;
  signals: Readonly<TargetSignals>;
}

/** The call a `custom` metric scores a target for. */
export interface CustomCall {
  request: Readonly<WireCallRequest>;
  context: CallContext | undefined;
  streaming: boolean;
}

/**
 * Scores a target for the `custom` metric: lower is better. Synchronous. A value that is not a
 * finite positive number counts as unknown, unless `custom` is the route's only metric.
 */
export type CustomMetric = (candidate: CustomCandidate, call: CustomCall) => number;
