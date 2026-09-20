import {
  ATTR,
  ERROR_CODE_FALLBACK_EXHAUSTED,
  ERROR_TYPE_OTHER,
  NO_ATTEMPT_REASON,
  OPERATION_CHAT,
  OUTPUT_TYPE_JSON,
  OUTPUT_TYPE_TEXT,
  VERNLLM_ATTR,
} from './semconv.js';

import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { CallMeta, WireCallRequest } from 'vern-llm';

// Everything here is a pure function over plain values, so it is testable without an
// OpenTelemetry SDK. Numbers are checked with Number.isFinite because provider usage and
// request fields are not guaranteed to be well formed.

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Writes `value` only when it is defined, so absent data never becomes an `undefined` attribute. */
function put(target: Attributes, key: string, value: AttributeValue | undefined): void {
  if (value !== undefined) target[key] = value;
}

export interface AttemptStartInput {
  /** Value for `gen_ai.provider.name`, already mapped through the provider names option. */
  provider: string;
  /** Raw VernLLM target label. */
  target: string;
  /** Model requested for this attempt. */
  model: string;
  /** 1 based within the target. */
  attempt: number;
  isFallback: boolean;
  request: Pick<
    WireCallRequest,
    'max_tokens' | 'temperature' | 'response_format' | 'reasoning_effort' | 'budget_tokens'
  >;
}

export function outputTypeOf(request: Pick<WireCallRequest, 'response_format'>): string {
  return request.response_format === undefined ? OUTPUT_TYPE_TEXT : OUTPUT_TYPE_JSON;
}

/**
 * Attributes for an attempt span at creation. The first three `gen_ai` ones are what a sampler
 * can act on, so they are always present when GenAI conventions are on.
 */
export function attemptStartAttributes(
  input: AttemptStartInput,
  genAiConventions: boolean,
): Attributes {
  const attrs: Attributes = {};

  if (genAiConventions) {
    attrs[ATTR.operationName] = OPERATION_CHAT;
    attrs[ATTR.providerName] = input.provider;
    attrs[ATTR.requestModel] = input.model;
    if (isCount(input.request.max_tokens)) attrs[ATTR.requestMaxTokens] = input.request.max_tokens;
    if (
      typeof input.request.temperature === 'number' &&
      Number.isFinite(input.request.temperature)
    ) {
      attrs[ATTR.requestTemperature] = input.request.temperature;
    }
    attrs[ATTR.outputType] = outputTypeOf(input.request);
    // The exact string sent to the provider, next to the VernLLM one below.
    if (isNonEmptyString(input.request.reasoning_effort)) {
      attrs[ATTR.requestReasoningLevel] = input.request.reasoning_effort;
    }
  }

  attrs[VERNLLM_ATTR.target] = input.target;
  if (typeof input.attempt === 'number' && Number.isInteger(input.attempt) && input.attempt >= 1) {
    attrs[VERNLLM_ATTR.attempt] = input.attempt;
  }
  attrs[VERNLLM_ATTR.isFallback] = input.isFallback === true;
  if (isNonEmptyString(input.request.reasoning_effort)) {
    attrs[VERNLLM_ATTR.requestReasoningEffort] = input.request.reasoning_effort;
  }
  if (isCount(input.request.budget_tokens)) {
    attrs[VERNLLM_ATTR.requestBudgetTokens] = input.request.budget_tokens;
  }

  return attrs;
}

export interface UsageInput {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

/** Token attributes for the attempt that spent them. Skips anything not a finite, non negative number. */
export function usageAttributes(usage: UsageInput, genAiConventions: boolean): Attributes {
  const attrs: Attributes = {};
  if (!genAiConventions) return attrs;

  if (isCount(usage.promptTokens)) attrs[ATTR.usageInputTokens] = usage.promptTokens;
  if (isCount(usage.completionTokens)) attrs[ATTR.usageOutputTokens] = usage.completionTokens;
  if (isCount(usage.reasoningTokens))
    attrs[ATTR.usageReasoningOutputTokens] = usage.reasoningTokens;

  return attrs;
}

/** Tokens spent on an attempt that then failed are recorded, and the failure is marked. */
export function usageFailureAttributes(usage: UsageInput, genAiConventions: boolean): Attributes {
  return { ...usageAttributes(usage, genAiConventions), [VERNLLM_ATTR.usageFailed]: true };
}

export interface CallStartInput {
  requestId: string;
  primaryProvider: string;
  primaryModel: string;
}

export function callStartAttributes(input: CallStartInput): Attributes {
  const attrs: Attributes = {};
  if (isNonEmptyString(input.requestId)) attrs[VERNLLM_ATTR.requestId] = input.requestId;
  if (isNonEmptyString(input.primaryProvider)) {
    attrs[VERNLLM_ATTR.primaryProvider] = input.primaryProvider;
  }
  if (isNonEmptyString(input.primaryModel)) attrs[VERNLLM_ATTR.primaryModel] = input.primaryModel;
  return attrs;
}

export type NoAttemptReason = (typeof NO_ATTEMPT_REASON)[keyof typeof NO_ATTEMPT_REASON];

export interface NoAttemptInput {
  attemptCount: number;
  hasMeta: boolean;
  shortCircuitedBy: string | undefined;
}

/**
 * Why a logical call made no attempt of its own, or `undefined` when it did. A call with no
 * `meta` never reached a provider (cache hit). One with `meta` but no attempt joined another
 * caller's in flight request. An inner `wrap` that answered without calling `next` is reported
 * by the core as an event, and wins over both.
 */
export function noAttemptReasonOf(input: NoAttemptInput): NoAttemptReason | undefined {
  if (input.attemptCount > 0) return undefined;
  if (isNonEmptyString(input.shortCircuitedBy)) return NO_ATTEMPT_REASON.shortCircuit;
  return input.hasMeta ? NO_ATTEMPT_REASON.coalesced : NO_ATTEMPT_REASON.cacheHit;
}

export interface CallEndInput {
  meta: CallMeta | undefined;
  /** Every attempt started, across all targets. */
  totalAttempts: number;
  streaming: boolean;
  noAttemptReason: NoAttemptReason | undefined;
  shortCircuitedBy: string | undefined;
}

export function callEndAttributes(input: CallEndInput): Attributes {
  const attrs: Attributes = {};
  const { meta } = input;

  if (meta) {
    if (isNonEmptyString(meta.provider)) attrs[VERNLLM_ATTR.answeredProvider] = meta.provider;
    if (isNonEmptyString(meta.model)) attrs[VERNLLM_ATTR.answeredModel] = meta.model;
    attrs[VERNLLM_ATTR.usedFallback] = meta.usedFallback === true;
    if (Number.isInteger(meta.fallbackIndex) && meta.fallbackIndex >= 0) {
      attrs[VERNLLM_ATTR.fallbackIndex] = meta.fallbackIndex;
    }
  }

  if (isCount(input.totalAttempts)) attrs[VERNLLM_ATTR.totalAttempts] = input.totalAttempts;
  attrs[VERNLLM_ATTR.streaming] = input.streaming === true;
  put(attrs, VERNLLM_ATTR.noAttemptReason, input.noAttemptReason);
  if (isNonEmptyString(input.shortCircuitedBy)) {
    attrs[VERNLLM_ATTR.shortCircuitBy] = input.shortCircuitedBy;
  }

  return attrs;
}

// Errors are recognised by shape, never with `instanceof` or `isLLMError`. vern-llm ships an ESM
// and a CJS build with a separate `LLMError` class each, so a single install can still hold two
// classes: an app that builds its VernLLM through ESM while this package is loaded through
// `require` (or the reverse), or a bundler that resolves different conditions for each. A second
// nested copy of vern-llm does the same. A class check would then fail for every real error and
// report all of them as `_OTHER`, silently losing the error type and status.

interface LlmErrorLike {
  name: 'LLMError';
  type: string;
  code?: unknown;
  status?: unknown;
  attempts?: unknown;
}

export function isLlmErrorLike(error: unknown): error is LlmErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; type?: unknown };
  return candidate.name === 'LLMError' && typeof candidate.type === 'string';
}

/** `code` when the error has one, else `type`. Both are enumerated, so cardinality stays low. */
export function errorTypeOf(error: unknown): string {
  if (!isLlmErrorLike(error)) return ERROR_TYPE_OTHER;
  if (isNonEmptyString(error.code)) return error.code;
  return isNonEmptyString(error.type) ? error.type : ERROR_TYPE_OTHER;
}

/** The same low cardinality string, never the provider's message: it can echo prompt text. */
export function statusMessageOf(error: unknown): string {
  return errorTypeOf(error);
}

export function httpStatusOf(error: unknown): number | undefined {
  if (!isLlmErrorLike(error)) return undefined;
  const { status } = error;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** Number of targets tried, when the error is a fallback exhausted one with a readable list. */
export function fallbackAttemptCountOf(error: unknown): number | undefined {
  if (!isLlmErrorLike(error)) return undefined;
  const exhausted =
    error.code === ERROR_CODE_FALLBACK_EXHAUSTED || error.type === ERROR_CODE_FALLBACK_EXHAUSTED;
  return exhausted && Array.isArray(error.attempts) ? error.attempts.length : undefined;
}

export interface ExceptionRecord {
  name: string;
  message: string;
  stack?: string;
}

/**
 * What an `exception` span event carries. The message is the same low cardinality code used
 * for the span status, never the error's own message, which can echo prompt text. A stack is
 * added only when asked for, and only when the error has one.
 */
export function exceptionOf(error: unknown, includeStack: boolean): ExceptionRecord {
  const record: ExceptionRecord = {
    name: isLlmErrorLike(error) ? 'LLMError' : 'Error',
    message: errorTypeOf(error),
  };

  const stack =
    typeof error === 'object' && error !== null ? (error as { stack?: unknown }).stack : undefined;
  if (includeStack && typeof stack === 'string') record.stack = stack;

  return record;
}

/**
 * The error that ended the last attempt. An exhausted fallback chain throws its own summary
 * error, but the attempt still open when it is thrown failed for the last target's reason, and
 * that reason is what the attempt span and duration metric should carry. Anything else is
 * returned unchanged.
 */
export function lastAttemptErrorOf(error: unknown): unknown {
  if (fallbackAttemptCountOf(error) === undefined) return error;

  const attempts = (error as LlmErrorLike).attempts as unknown[];
  const snapshot = (attempts[attempts.length - 1] as { error?: unknown } | null | undefined)?.error;
  if (typeof snapshot !== 'object' || snapshot === null) return error;

  const { type, code, status } = snapshot as { type?: unknown; code?: unknown; status?: unknown };
  return typeof type === 'string' ? { name: 'LLMError', type, code, status } : error;
}

export function errorAttributes(error: unknown): Attributes {
  const attrs: Attributes = { [ATTR.errorType]: errorTypeOf(error) };
  put(attrs, ATTR.httpStatusCode, httpStatusOf(error));
  put(attrs, VERNLLM_ATTR.fallbackAttempts, fallbackAttemptCountOf(error));
  return attrs;
}

/**
 * Keeps only what OpenTelemetry can carry from a user supplied bag: strings, finite numbers,
 * booleans, and arrays of a single one of those. Everything else is dropped rather than
 * stringified, so an object with a secret in it never becomes an attribute by accident.
 */
export function sanitizeAttributes(value: unknown): Attributes {
  const attrs: Attributes = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return attrs;

  for (const [key, item] of Object.entries(value)) {
    if (key === '') continue;
    const safe = toAttributeValue(item);
    if (safe !== undefined) attrs[key] = safe;
  }

  return attrs;
}

function toAttributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;

  if (value.every((item) => typeof item === 'string')) return value as string[];
  if (value.every((item) => typeof item === 'boolean')) return value as boolean[];
  if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return value as number[];
  }
  return undefined;
}

/** Monotonic clock, so a wall clock adjustment can never produce a negative duration. */
export function nowMs(): number {
  return performance.now();
}

/**
 * Milliseconds from `startMs` to `endMs`, minus time spent waiting locally (rate limit queue),
 * so the result measures the provider and not our own queueing. Never negative and never NaN.
 */
export function elapsedMs(startMs: number, waitedMs = 0, endMs: number = nowMs()): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  const waited = Number.isFinite(waitedMs) && waitedMs > 0 ? waitedMs : 0;
  return Math.max(0, endMs - startMs - waited);
}
