import {
  ATTR,
  NO_ATTEMPT_REASON,
  OPERATION_CHAT,
  OUTPUT_TYPE_JSON,
  OUTPUT_TYPE_TEXT,
  VERNLLM_ATTR,
} from '../semconv.js';
import { isCount, isNonEmptyString, put } from './values.utils.js';

import type { Attributes } from '@opentelemetry/api';
import type { CallMeta, WireCallRequest } from 'vern-llm';

// Everything here is a pure function over plain values, so it is testable without an
// OpenTelemetry SDK.

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
 * The Anthropic and Bedrock adapters leave `temperature` off the wire whenever thinking is on,
 * because Claude rejects the two together. Recording it then would report a value never sent.
 */
function dropsTemperature(input: AttemptStartInput): boolean {
  const thinking =
    isNonEmptyString(input.request.reasoning_effort) || isCount(input.request.budget_tokens);
  if (!thinking) return false;
  if (input.provider === 'anthropic') return true;
  return input.provider === 'aws.bedrock' && /anthropic|claude/i.test(input.model);
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
      Number.isFinite(input.request.temperature) &&
      !dropsTemperature(input)
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
