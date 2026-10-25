import type { Decision } from './decision.js';
import type { PolicyOptions, RequestFacts } from './options.js';
import type { CallContext, VernLLMMiddleware } from 'vern-llm';

/** Everything that defines a policy, which `update` replaces as a whole. Not the logger. */
export type PolicyUpdate = Omit<PolicyOptions, 'logger'>;

/** One target as `evaluate` takes it. */
export interface EvaluateTarget {
  name: string;
  /** The effective model for the call. */
  model: string;
  /** What the adapter reports, when it knows. */
  provider?: string;
}

/** A call described as data, for `evaluate`. */
export interface EvaluateInput {
  context?: CallContext;
  /** The targets the call would have, in order. */
  targets: readonly EvaluateTarget[];
  /** Omitted facts are `false`, or `0` for `inputTokens`. */
  request?: Partial<RequestFacts>;
  /** `true` when the call passes its own `targets`. */
  callTargets?: boolean;
  /** What `labels` would have returned. Omitted means unknown, not `[]`. */
  labels?: readonly string[];
  /** The moment to decide at. Default: now. */
  now?: Date | number;
}

/** The middleware, plus `evaluate` and `update`. */
export interface PolicyMiddleware extends VernLLMMiddleware {
  /** The decision a call like this would get, from plain data. Makes no call and emits nothing. */
  evaluate(input: EvaluateInput): Decision;
  /**
   * Replaces everything except the logger. It is validated first: a bad one throws and the old one
   * stays. A call already started keeps its policy.
   */
  update(policy: PolicyUpdate): void;
}
