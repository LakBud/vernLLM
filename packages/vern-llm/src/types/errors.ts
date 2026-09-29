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
 * Machine readable detail within a `type`, for when `type` alone is too coarse to act on. Optional:
 * errors from before a code existed omit it.
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
  | 'invalid_context'
  // Middleware (invalid_params)
  | 'middleware_threw'
  // Rate limiting (rate_limited)
  | 'rate_limit_queue_full'
  | 'rate_limit_queue_timeout'
  | 'rate_limit_capacity_exceeded'
  | 'provider_rate_limited'
  // Retry budget (rate_limited)
  | 'retry_budget_exhausted'
  // Timeouts (timeout)
  | 'request_timeout'
  | 'idle_timeout'
  | 'reader_stall_timeout'
  | 'middleware_timeout'
  // Deadline (aborted)
  | 'deadline_exceeded'
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
  | 'stream_frame_invalid'
  | 'response_truncated'
  // Soft failure (api, default; a custom code can also override the type)
  | 'soft_failure_detected';

/**
 * Model or provider response defects. Deterministic for the same request, so never retried and
 * never counted toward the breaker.
 */
export const NON_RETRYABLE_TOOL_CONTRACT_CODES: ReadonlySet<LLMErrorCode> = new Set([
  'unknown_tool',
  'duplicate_tool_call_id',
  'tool_choice_none_violated',
  'unexpected_tool_calls',
]);

/**
 * Local limiter rejections. The provider was never reached, and retrying either requeues behind the
 * same limit or can never succeed.
 */
export const LOCAL_RATE_LIMIT_CODES: ReadonlySet<LLMErrorCode> = new Set([
  'rate_limit_queue_full',
  'rate_limit_queue_timeout',
  'rate_limit_capacity_exceeded',
  'retry_budget_exhausted',
]);

/**
 * A middleware `transform` or `enabled` timed out. Retrying reruns the same slow code, so unlike a
 * provider timeout it is not retryable.
 */
export const NON_RETRYABLE_MIDDLEWARE_TIMEOUT_CODES: ReadonlySet<LLMErrorCode> = new Set([
  'middleware_timeout',
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
 * The retry rule behind both `LLMError.retryable` and `LLMErrorSnapshot.retryable`, kept in one
 * place so they can't drift.
 */
function computeRetryable(type: LLMErrorType, code: LLMErrorCode | undefined): boolean {
  // Output cut off at max_tokens can come back complete on a resend, since
  // generation varies, unlike a reply that was whole and still malformed.
  if (code === 'response_truncated') return true;
  if (NON_RETRYABLE_TYPES.has(type)) return false;
  if (code && NON_RETRYABLE_TOOL_CONTRACT_CODES.has(code)) return false;
  if (code && LOCAL_RATE_LIMIT_CODES.has(code)) return false;
  if (code && NON_RETRYABLE_MIDDLEWARE_TIMEOUT_CODES.has(code)) return false;
  // Resending the same oversized body can only be rejected again.
  if (code === 'payload_too_large') return false;
  return true;
}

/**
 * Retryable types that still say nothing about provider health, so they never count toward the
 * breaker.
 */
const NON_BREAKER_TYPES: ReadonlySet<LLMErrorType> = new Set(['quota_exceeded']);

/**
 * 4xx statuses that describe the provider rather than one caller's request. Any other 4xx counting
 * would let one bad caller open the circuit for everyone.
 */
const PROVIDER_SIDE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

function isCallerSideStatus(status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    !PROVIDER_SIDE_CLIENT_STATUSES.has(status)
  );
}

/**
 * The breaker rule behind `LLMError.countsTowardBreaker`. Never counts what `computeRetryable`
 * excludes.
 */
function computeCountsTowardBreaker(
  type: LLMErrorType,
  code: LLMErrorCode | undefined,
  status: number | undefined,
): boolean {
  if (!computeRetryable(type, code)) return false;
  if (NON_BREAKER_TYPES.has(type)) return false;
  // The provider answered fine, the caller's max_tokens was too small.
  if (code === 'response_truncated') return false;
  if (isCallerSideStatus(status)) return false;
  return true;
}

/**
 * `issues` if it survives `JSON.stringify`, otherwise a marker string. Only a caller supplied
 * schema validator's error can be circular.
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

/**
 * A JSON safe copy of `body`, or a marker string if it can't be serialized. Cloned, not shared,
 * since adapter code can still mutate the request after dispatch (`fromGemini` sets
 * `request.config` in place).
 */
function safeBody(body: unknown): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(body)) as unknown;
  } catch {
    return '[Unserializable: request body contained a circular reference]';
  }
}

const AUTH_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key']);

/** Removes auth headers before a request snapshot is built. Case insensitive on header names. */
function stripAuthHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!AUTH_HEADER_NAMES.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * Depth cap for `safeAttempts`, since a caller can hand build a self referential `attempts` array.
 */
const MAX_ATTEMPTS_DEPTH = 20;

/**
 * Copies `attempts` with every nested `issues`, request `body` and request headers rechecked,
 * recursively. A caller can pass hand built attempts straight to the constructor, and a shared
 * `issues` object can turn circular after capture. Extra fields such as `FallbackAttempt.provider`
 * are kept.
 */
function safeAttempts(attempts: RetryAttempt[] | undefined, depth = 0): RetryAttempt[] | undefined {
  if (attempts === undefined) return undefined;
  if (depth >= MAX_ATTEMPTS_DEPTH) return [];

  return attempts.map((attempt) => ({
    ...attempt,
    error: {
      ...attempt.error,
      issues: safeIssues(attempt.error.issues),
      attempts: safeAttempts(attempt.error.attempts, depth + 1),
    },
    request: attempt.request && {
      ...attempt.request,
      body: safeBody(attempt.request.body),
      headers: stripAuthHeaders(attempt.request.headers),
    },
  }));
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
 * The exact `issues` shape for each code that carries one. Codes whose message already says
 * everything have no entry. Schema validation `issues` stay untyped, since they come from the
 * caller's own validator.
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
 * Plain data copy of an `LLMError`, as held by `RetryAttempt.error`. Never thrown again, so no
 * `cause` and no live getters. Nested `attempts` form a tree, not a cycle.
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
 * Plain data copy of the request an attempt sent, as held by `RetryAttempt.request`. Safe to
 * serialize and store.
 */
export interface LLMRequestSnapshot {
  /** Provider id this attempt targeted, e.g. "openai". */
  provider: string;
  /** Model id this attempt targeted. */
  model: string;
  /** The payload as actually sent for this attempt, after any transform/repair. Passed through `safeBody`. */
  body: unknown;
  /** Non sensitive request headers. Auth headers are stripped before the snapshot is built, never included. */
  headers?: Record<string, string>;
  /** Wall clock time the attempt started, ms since epoch. */
  startedAt: number;
}

/**
 * A plain data copy of one attempt's request. Pass `startedAt` when known: this often runs after
 * the attempt failed, so `Date.now()` would record the wrong time.
 */
export function toRequestSnapshot(
  provider: string,
  model: string,
  body: unknown,
  headers?: Record<string, string>,
  startedAt: number = Date.now(),
): LLMRequestSnapshot {
  return {
    provider,
    model,
    body: safeBody(body),
    headers: stripAuthHeaders(headers),
    startedAt,
  };
}

/** One failed attempt: its index and a snapshot of its error. `FallbackAttempt` extends it. */
export interface RetryAttempt {
  index: number;
  error: LLMErrorSnapshot;
  /** What was sent for this attempt. Optional: absent for attempts predating this field. */
  request?: LLMRequestSnapshot;
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
   * Whether retrying could help, from `type` and `code` alone. See Error Handling for the full
   * list. `response_truncated` is retryable despite its `parse` type.
   */
  get retryable(): boolean {
    return computeRetryable(this.type, this.code);
  }

  /**
   * Whether this failure counts toward the breaker. Stricter than `retryable`: `quota_exceeded` and
   * any 4xx other than 408, 425 and 429 are excluded.
   */
  get countsTowardBreaker(): boolean {
    return computeCountsTowardBreaker(this.type, this.code, this.status);
  }

  /**
   * Copies the fields into an `LLMErrorSnapshot`. `cause` is left out, and `issues` are made
   * serialization safe.
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
      attempts: safeAttempts(this.attempts),
    };
  }

  /**
   * Serializes `message` and `retryable` too, which a plain property walk misses. `cause` is left
   * out since SDK errors can be circular; read `err.cause` directly.
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
      attempts: safeAttempts(this.attempts),
    };
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}

/**
 * Narrows `err.issues` to the shape `LLMErrorIssuesByCode` maps `code` to, so no cast is needed.
 */
export function hasIssues<C extends keyof LLMErrorIssuesByCode>(
  err: LLMError,
  code: C,
): err is LLMError & { code: C; issues: LLMErrorIssuesByCode[C] } {
  return err.code === code && err.issues !== undefined;
}
