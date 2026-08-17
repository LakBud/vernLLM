export type LLMErrorType =
  | 'timeout'
  | 'api'
  | 'network'
  | 'parse'
  | 'validation'
  | 'invalid_params'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'circuit_open'
  | 'fallback_exhausted'
  | 'aborted'
  | 'unknown';

/**
 * Machine readable discriminator within a `type`, for cases where `type`
 * alone is too coarse to act on. Optional and additive: errors thrown
 * before a given code existed simply omit it. Not owned by a single type;
 * e.g. `authentication`/`authorization` apply the same way regardless of
 * which type wraps them.
 */
export type LLMErrorCode =
  // Tool contract (validation)
  | 'unknown_tool'
  | 'duplicate_tool_call_id'
  | 'tool_choice_none_violated'
  | 'unexpected_tool_calls'
  // Caller input (invalid_params)
  | 'unsupported_capability'
  | 'duplicate_tool_names'
  | 'unknown_tool_choice'
  | 'duplicate_tool_result_ids'
  | 'unknown_tool_result_ids'
  | 'missing_tool_results'
  // Rate limiting (rate_limited)
  | 'rate_limit_queue_full'
  | 'rate_limit_queue_timeout'
  | 'rate_limit_capacity_exceeded'
  | 'provider_rate_limited'
  // Timeouts (timeout)
  | 'request_timeout'
  | 'idle_timeout'
  // HTTP status (api)
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'payload_too_large'
  | 'server_error'
  | 'empty_response'
  // Connectivity (network)
  | 'connection_failed'
  // Circuit breaker (circuit_open)
  | 'circuit_cooling_down'
  | 'circuit_trial_in_flight'
  // Fallback (fallback_exhausted)
  | 'fallback_exhausted'
  // Parsing (parse)
  | 'tool_arguments_parse_failed'
  | 'stream_frame_invalid';

/**
 * Tool contract codes: a model or provider response defect, not a
 * transient provider fault. Deterministic on the wire request, so
 * retrying can't change the outcome and it shouldn't count toward the
 * circuit breaker either. Shared by `LLMError.retryable` below and by
 * `CallExecutor`'s own retry/breaker accounting, so the two can't drift
 * apart.
 */
export const NON_RETRYABLE_TOOL_CONTRACT_CODES: ReadonlySet<LLMErrorCode> = new Set([
  'unknown_tool',
  'duplicate_tool_call_id',
  'tool_choice_none_violated',
  'unexpected_tool_calls',
]);

/**
 * Local rate-limit codes: the call never reached the provider, so it says
 * nothing about the provider's health, and retrying either just requeues
 * behind the same limit (the two queue codes) or can never succeed at all
 * (`rate_limit_capacity_exceeded`). Shared for the same reason as
 * {@link NON_RETRYABLE_TOOL_CONTRACT_CODES}.
 */
export const LOCAL_RATE_LIMIT_CODES: ReadonlySet<LLMErrorCode> = new Set([
  'rate_limit_queue_full',
  'rate_limit_queue_timeout',
  'rate_limit_capacity_exceeded',
]);

/**
 * Types that are never worth retrying on their own: deterministic
 * caller-input, model-response, or cancellation failures rather than a
 * transient provider fault.
 */
const NON_RETRYABLE_TYPES: ReadonlySet<LLMErrorType> = new Set([
  'parse',
  'validation',
  'invalid_params',
  'aborted',
]);

/**
 * Shared retryability rule behind both `LLMError.retryable` and
 * `LLMErrorSnapshot.retryable`. Pulled out so the two can't drift apart:
 * a snapshot is a point-in-time copy of an error's fields, and this is
 * one of them, so it has to be computed the same way in both places.
 */
function computeRetryable(type: LLMErrorType, code: LLMErrorCode | undefined): boolean {
  if (NON_RETRYABLE_TYPES.has(type)) return false;
  if (code && NON_RETRYABLE_TOOL_CONTRACT_CODES.has(code)) return false;
  if (code && LOCAL_RATE_LIMIT_CODES.has(code)) return false;
  return true;
}

/**
 * Returns `issues` unchanged when it can survive `JSON.stringify`.
 * Most `issues` values are VernLLM's own structured shapes (see
 * `LLMErrorIssuesByCode`) and always safe. The one exception is a
 * schema validation failure, where `issues` is a caller supplied
 * `SchemaLike` validator's own `error: unknown`, not controlled by
 * VernLLM and not guaranteed to be circular free. Rather than silently
 * dropping it in that case, this returns a marker string so a reader
 * of serialized output can tell "no issues data" apart from "issues
 * existed but could not be shown".
 */
function safeIssues(issues: unknown): unknown {
  if (issues === undefined) return undefined;
  try {
    JSON.stringify(issues);
    return issues;
  } catch {
    return '[Unserializable: issues contained a circular reference]';
  }
}

/** One tool call's contract failure, used to report every bad call in a response at once. */
export interface ToolIssue {
  name: string;
  toolCallId: string;
  code: LLMErrorCode;
  detail?: unknown;
}

/**
 * The specific values behind a `duplicate_tool_names` failure: the
 * offending call's `tools` array had more than one entry sharing a name.
 */
export interface DuplicateToolNamesIssue {
  names: string[];
}

/**
 * The specific values behind an `unknown_tool_choice` failure: `toolChoice`
 * named a tool that wasn't in the call's own `tools` array.
 */
export interface UnknownToolChoiceIssue {
  requested: string;
  available: string[];
}

/**
 * The specific values behind a `duplicate_tool_result_ids` /
 * `unknown_tool_result_ids` / `missing_tool_results` failure: which
 * `history` turn was affected, and which `toolCallId`s were the problem.
 */
export interface HistoryToolResultIssue {
  historyIndex: number;
  ids: string[];
}

/**
 * The specific values behind an `unsupported_capability` failure: which
 * capability the current adapter/client/model doesn't support.
 */
export interface UnsupportedCapabilityIssue {
  capability: string;
}

/**
 * Maps each `LLMErrorCode` that carries structured `issues` to that
 * payload's exact shape. Not every code appears here: most `invalid_params`
 * failures are a single deterministic fact the `message` already states in
 * full, so adding a typed `issues` entry for them would only duplicate the
 * message into a field, the same near-duplicate-code problem `code` itself
 * avoids. Codes that repeat here are exactly the ones whose `message`
 * already string-joins a list a caller might want to consume directly
 * rather than re-parse out of prose, or that otherwise want a place to
 * report the exact captured values of a failure.
 *
 * Deliberately not a mapped type over the whole `LLMErrorCode` union: a
 * schema-validation failure's `issues` (the caller's own Zod-compatible
 * validator's error object) has no code and no shape VernLLM could know in
 * advance, so it stays untyped on `LLMError.issues` itself rather than
 * forcing every code into this table.
 */
export interface LLMErrorIssuesByCode {
  unknown_tool: ToolIssue[];
  duplicate_tool_call_id: ToolIssue[];
  duplicate_tool_names: DuplicateToolNamesIssue;
  unknown_tool_choice: UnknownToolChoiceIssue;
  duplicate_tool_result_ids: HistoryToolResultIssue;
  unknown_tool_result_ids: HistoryToolResultIssue;
  missing_tool_results: HistoryToolResultIssue;
  unsupported_capability: UnsupportedCapabilityIssue;
}

/**
 * Point-in-time copy of an `LLMError`'s fields, produced by
 * `LLMError.toSnapshot()`. This is what `RetryAttempt.error` holds
 * instead of a live `LLMError`.
 *
 * A past attempt only needs to be describable (message, type, code,
 * whether it was retryable), never thrown again. So it skips `Error`'s
 * behavior, `instanceof` identity, and any live getter. Using the full
 * `LLMError` class here would also make the type self referential
 * through its own `attempts` field.
 *
 * Has no `cause`. `cause` is `unknown` and never validated by VernLLM,
 * and it is meant to be read directly on the live error you just
 * caught, not carried indefinitely inside history. `type`, `code`,
 * `status`, and `issues` are the structured fields a snapshot carries
 * instead.
 *
 * `attempts` is still present, since a recorded attempt can itself be
 * the terminal failure of an inner retry loop with its own history (see
 * `FallbackAttempt`). That's a tree of past data, not a cycle.
 */
export interface LLMErrorSnapshot {
  message: string;
  type: LLMErrorType;
  status?: number;
  issues?: unknown;
  retryAfterMs?: number;
  code?: LLMErrorCode;
  /** Computed once, at snapshot time, since a snapshot has no live getter. */
  retryable: boolean;
  /** This attempt's own prior attempts, if it was itself the terminal failure of a retry loop. */
  attempts?: RetryAttempt[];
}

/**
 * One failed attempt on the way to a terminal error: which attempt index
 * it was, and a snapshot of the error it failed with. The base shape
 * every richer attempt record (e.g. `FallbackAttempt`) extends, rather
 * than duplicates.
 */
export interface RetryAttempt {
  index: number;
  error: LLMErrorSnapshot;
}

/** Optional fields for constructing an {@link LLMError}. `message` and `type` stay positional since every throw site sets both. */
export interface LLMErrorOptions {
  status?: number;
  issues?: unknown;
  cause?: unknown;
  retryAfterMs?: number;
  /** Stable discriminator within `type`. Absent on errors predating it. */
  code?: LLMErrorCode;
  /** Every attempt made before this error was thrown, in order. Absent when nothing was retried. */
  attempts?: RetryAttempt[];
}

export class LLMError extends Error {
  public status?: number;
  public issues?: unknown;
  public cause?: unknown;
  public retryAfterMs?: number;
  /** Stable discriminator within `type`. Absent on errors predating it. */
  public code?: LLMErrorCode;
  /** Every attempt made before this error was thrown, in order. Absent when nothing was retried. */
  public attempts?: RetryAttempt[];

  constructor(
    message: string,
    public type: LLMErrorType,
    options: LLMErrorOptions = {},
  ) {
    super(message);
    this.name = 'LLMError';
    this.status = options.status;
    this.issues = options.issues;
    this.cause = options.cause;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
    this.attempts = options.attempts;
  }

  /**
   * Computed purely from `type`/`code`, independent of any specific call's
   * `nonRetryableStatus` list. False for `parse`/`validation`/
   * `invalid_params`/`aborted` types (the caller's own input, the model's
   * own response, or intentional cancellation, none of which are the
   * provider being unhealthy), the tool contract codes, and the local
   * rate limit codes. Subclasses (see `FallbackExhaustedError`) may
   * override this when `type` alone carries no retry signal.
   */
  get retryable(): boolean {
    return computeRetryable(this.type, this.code);
  }

  /**
   * Copies this error's fields into an {@link LLMErrorSnapshot}, for
   * recording as a `RetryAttempt`/`FallbackAttempt`. `retryable` is
   * captured here since a snapshot has no getter of its own. `attempts`
   * is copied as is, since an `LLMError`'s own `attempts` already holds
   * snapshots, never live errors. `cause` is not copied, see
   * `LLMErrorSnapshot`'s own doc. `issues` goes through `safeIssues`,
   * since a schema validation failure's `issues` is a caller supplied
   * value, not controlled by VernLLM.
   */
  toSnapshot(): LLMErrorSnapshot {
    return {
      message: this.message,
      type: this.type,
      status: this.status,
      issues: safeIssues(this.issues),
      retryAfterMs: this.retryAfterMs,
      code: this.code,
      retryable: this.retryable,
      attempts: this.attempts,
    };
  }

  /**
   * Controls what `JSON.stringify(err)` produces. Omits `cause` for the
   * same reason `toSnapshot()` does: `cause` is `unknown` and never
   * validated by VernLLM, and some SDK errors carry circular structures
   * `JSON.stringify` cannot serialize at all. Read `err.cause` directly
   * instead. `issues` goes through `safeIssues` for the same reason:
   * a schema validation failure's `issues` is caller supplied and not
   * guaranteed circular free. Also includes `message` and `retryable`,
   * which a plain property walk would otherwise miss: `message` is
   * non-enumerable on `Error`, and `retryable` is a getter, not an own
   * property.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      type: this.type,
      status: this.status,
      issues: safeIssues(this.issues),
      retryAfterMs: this.retryAfterMs,
      code: this.code,
      retryable: this.retryable,
      attempts: this.attempts,
    };
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}

/**
 * Narrows `err.issues` to the exact shape {@link LLMErrorIssuesByCode} maps
 * `code` to, for any code listed there. `code` stays the only discriminator
 * VernLLM uses; this just gives that existing check a typed return instead
 * of requiring a manual cast of `issues`:
 *
 * ```ts
 * if (isLLMError(err) && hasIssues(err, 'duplicate_tool_names')) {
 *   console.log(err.issues.names); // string[], no cast needed
 * }
 * ```
 */
export function hasIssues<C extends keyof LLMErrorIssuesByCode>(
  err: LLMError,
  code: C,
): err is LLMError & { code: C; issues: LLMErrorIssuesByCode[C] } {
  return err.code === code && err.issues !== undefined;
}
