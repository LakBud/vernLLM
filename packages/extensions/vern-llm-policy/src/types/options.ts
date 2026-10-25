import type { CallContext, Logger, PreDispatchContext } from 'vern-llm';

/** Same shape as `VernLLMOptions.logger`. */
export type LoggerOption = Logger | 'silent';

/** A value a pattern compares a fact to. Matching is strict: `1` is not `'1'`. */
export type Scalar = string | number | boolean;

/** A synchronous test over facts. It matches only when it returns exactly `true`. */
export type PatternFunction = (facts: never) => boolean;

/**
 * One matcher for target patterns and `when`: `{ key: value }`, `{ key: [a, b] }` for any of them,
 * several keys that must all match, `{ not }`, `{ any: [...] }`, and `{ gte, lte }` on a number.
 * A missing fact never equals anything, so `{ not: { region: 'eu' } }` matches an undeclared one.
 */
export interface PatternObject {
  readonly [key: string]:
    | Scalar
    | readonly Scalar[]
    | PatternObject
    | PatternFunction
    | readonly (PatternObject | PatternFunction)[]
    // Lets a pattern kept in a variable type check. A real `undefined` is refused at build.
    | undefined;
}

/** A pattern is an object of keys to match, or a function over the facts. */
export type Pattern<Facts> = ((facts: Facts) => boolean) | PatternObject;

/** What a target pattern sees: `name`, `model`, `provider` when known, and declared attributes. */
export type TargetFacts = Readonly<Record<string, Scalar | undefined>>;

/** What a call looks like to a `when` pattern. */
export interface RequestFacts {
  hasTools: boolean;
  jsonOutput: boolean;
  images: boolean;
  /** An estimate of the request's input tokens, from the core's `defaultEstimateTokens`. */
  inputTokens: number;
  streaming: boolean;
}

/** What a `when` pattern sees. */
export interface CallFacts {
  /** The call's `context`. Absent when the call passed none. */
  context?: CallContext;
  request: RequestFacts;
  /** `true` when the call passed its own `targets`. */
  callTargets: boolean;
  /** The labels for this call. Absent when unknown, which is not `[]`. */
  labels?: readonly string[];
}

/** A time bound way past one rule. While it covers a call, the rule does not apply to it. */
export interface PolicyException {
  /** Which calls it covers. Required, since none would cover every call. */
  when: Pattern<CallFacts>;
  /** When it ends, exclusive: an ISO date (midnight UTC) or a date and time with an offset. */
  until: string;
  /** Why it exists, for the decision. */
  reason: string;
}

/** A rule: at most one of `allow` and `forbid`, and at least one of `allow`, `forbid`, `set`. */
export interface PolicyRule {
  /** Unique and stable: it names the rule in decisions and errors. */
  id: string;
  /** When the rule applies. Omitted: always. */
  when?: Pattern<CallFacts>;
  /** Only targets matching this pattern may be used, while the rule applies. */
  allow?: Pattern<TargetFacts>;
  /** Targets matching this pattern are removed, or `'all'` to deny the call. */
  forbid?: Pattern<TargetFacts> | 'all';
  /** Flags for other middleware, `false` winning when rules disagree. Never enforced by policy. */
  set?: Readonly<Record<string, boolean>>;
  /** Time bound exceptions: the rule does not apply to a call one of them covers. */
  except?: readonly PolicyException[];
  /** `'audit'` reports what the rule would remove and changes nothing. Omitted: the policy's. */
  mode?: 'enforce' | 'audit';
}

export interface PolicyOptions {
  /** Names this set of rules in every decision and denial. */
  version?: string;
  /**
   * What a throwing rule does. `'closed'` (default): a forbid applies, an allow grants nothing, and a
   * failing policy denies. `'open'` skips the rule and lets the call through.
   */
  onError?: 'closed' | 'open';
  /** `'audit'` makes every rule report instead of enforce. A rule's own `mode` wins. */
  mode?: 'enforce' | 'audit';
  /** What a call may use when no applicable rule has an `allow`: every target, or none. */
  default?: 'allow' | 'deny';
  /** Facts about each target by name, such as `{ region: 'eu' }`. Declared by you, never inferred. */
  targets?: Readonly<Record<string, Readonly<Record<string, Scalar>>>>;
  rules?: readonly PolicyRule[];
  /**
   * Content labels for `when: { labels }`. Return `[]` when it found nothing and `undefined` when it
   * did not run: unknown labels follow `onError`.
   */
  labels?: (ctx: PreDispatchContext) => readonly string[] | undefined;
  /** Where the policy reports its own failures and configuration warnings. */
  logger?: LoggerOption;
}
