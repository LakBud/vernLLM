/** A pattern or `when` function that threw while a call was decided. */
export interface DecisionError {
  /** The rule that threw. Absent when the policy itself failed. */
  rule?: string;
  /** The kind of error that was thrown, such as `TypeError`. */
  name: string;
  /** What it said, cut short. It is the author's own text and may hold anything. */
  message: string;
}

/** A `DecisionError` in the event, without the message. */
export type PolicyEventError = Omit<DecisionError, 'message'>;

/** An exception that covered a rule for one call. */
export interface DecisionException {
  rule: string;
  reason: string;
  /** The `until` the exception was written with. */
  until: string;
}

/** What policy decided for one call. */
export interface Decision {
  /** The `version` of the policy that decided, when it has one. */
  version?: string;
  /** `narrowed` means some targets were removed and some are left. */
  outcome: 'allowed' | 'narrowed' | 'denied';
  /** The targets that stay, in the order the call had them. Empty only when denied. */
  allowed: readonly string[];
  /** Each removed target and its rule, or `'default'`. The smallest id is named, so order never matters. */
  removed: Readonly<Record<string, string>>;
  /** The ids of the rules named in `removed`, sorted. */
  rules: readonly string[];
  /** Each audit rule and the targets it would have removed. `'default'` is `default: 'deny'`. */
  audit: Readonly<Record<string, readonly string[]>>;
  /** Every distinct failure of a rule, sorted. */
  errors: readonly DecisionError[];
  /** The merged flags, `false` winning. What `policyFlags(ctx)` returns. */
  flags: Readonly<Record<string, boolean>>;
  /** Each flag that is `false` and the rule that set it, the smallest id when several did. */
  flagCauses: Readonly<Record<string, string>>;
  /** The exceptions that covered a rule, sorted. Ended ones are not here. */
  exceptions: readonly DecisionException[];
  /** The labels, sorted, or `'unknown'`. Absent when no rule uses labels. */
  labels?: readonly string[] | 'unknown';
}

/**
 * The `policy.decision` event: one per call, emitted before the call goes on, with ids and names
 * only and never a `context` value.
 */
export interface PolicyDecisionEvent {
  v: 1;
  version?: string;
  outcome: Decision['outcome'];
  removed: Decision['removed'];
  audit: Decision['audit'];
  /** What failed, never what it said: an error message is the author's text and may hold call data. */
  errors: readonly PolicyEventError[];
  /** Flag to the rule that set it `false`. */
  flags: Decision['flagCauses'];
  exceptions: Decision['exceptions'];
  labels?: Decision['labels'];
}

/**
 * The `policy.cross_join` event: a call joined another caller's `cachedCall` and was answered by a
 * target this caller's rules removed. The core ignores a joiner's narrowing, so only the cache key
 * can keep the two apart. Ids and names only.
 */
export interface PolicyCrossJoinEvent {
  v: 1;
  version?: string;
  /** The target that answered. */
  target: string;
  /** The rule that removed it for this caller. */
  rule: string;
}
