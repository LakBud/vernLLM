import type { Matcher } from '../internal/match/types.js';
import type { Scalar, TargetFacts } from './options.js';
import type { PreDispatchContext } from 'vern-llm';

/** Stands for `default: 'deny'` in a decision, so no rule can have this id. */
export const DEFAULT_CAUSE = 'default';

export interface CompiledException {
  readonly when: Matcher;
  /** The `until` as written. */
  readonly until: string;
  /** The instant it ends, exclusive. */
  readonly end: number;
  readonly reason: string;
}

export interface CompiledRule {
  readonly id: string;
  /** The rule's own `mode`, else the policy's. */
  readonly mode: 'enforce' | 'audit';
  /** Absent: always applies. */
  readonly when?: Matcher;
  readonly allow?: Matcher;
  readonly forbid?: Matcher;
  /** Flags set while the rule applies. */
  readonly set?: Readonly<Record<string, boolean>>;
  readonly except: readonly CompiledException[];
}

/** Which call facts are built, because some rule reads them. */
export interface PolicyNeeds {
  inputTokens: boolean;
  images: boolean;
  /** The `labels` option has to run. */
  labels: boolean;
  /** A pattern matches on labels. */
  readsLabels: boolean;
  /** A `when` is a function. */
  functions: boolean;
}

/** A validated, frozen policy. A call reads one reference from start to end. */
export interface CompiledPolicy {
  readonly version?: string;
  readonly onError: 'closed' | 'open';
  /** The policy is in audit mode, so `default: 'deny'` only reports. */
  readonly auditDefault: boolean;
  readonly default: 'allow' | 'deny';
  /** Declared attributes per target, copied from the options. */
  readonly declared: Readonly<Record<string, Readonly<Record<string, Scalar>>>>;
  readonly rules: readonly CompiledRule[];
  readonly labels?: (ctx: PreDispatchContext) => readonly string[] | undefined;
  readonly needs: Readonly<PolicyNeeds>;
}

/** One target as `evaluate` sees it. */
export interface EvaluatedTarget {
  name: string;
  facts: TargetFacts;
}
