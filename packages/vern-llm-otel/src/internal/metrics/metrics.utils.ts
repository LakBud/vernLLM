import {
  metrics as metricsApi,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
} from '@opentelemetry/api';

import { isNonEmptyString } from '../attributes/values.utils.js';
import { errorTypeOf } from '../errors/errorMapping.utils.js';
import {
  ATTR,
  INSTRUMENTATION_NAME,
  OPERATION_CHAT,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  VERNLLM_ATTR,
} from '../semconv.js';
import { CATALOG, type InstrumentSpec, type MetricKey } from './catalog.js';

import type { ResolvedConfig } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { TokenUsage, VernLLMEvent } from 'vern-llm';

export const NORMALIZED_MODEL_CACHE_LIMIT = 1024;

export interface Metrics {
  /** The only recording path. Never throws. */
  record(key: MetricKey, value: number, attributes: Attributes, context?: Context): void;
  /** Records whatever measurements one VernLLM event carries. Never throws. */
  recordEvent(event: VernLLMEvent, context?: Context): void;
}

type ConfigSlice = Pick<
  ResolvedConfig,
  'meter' | 'metrics' | 'genAiConventions' | 'normalizeModel' | 'providerName' | 'targetName'
>;

type Instrument = Histogram | Counter;

const MODEL_ATTRIBUTES: readonly string[] = [ATTR.requestModel, VERNLLM_ATTR.model];

export function createMetrics(config: ConfigSlice, guard: Guard): Metrics {
  // A `null` entry means creation failed once and was logged, so it is not retried per call.
  const instruments = new Map<MetricKey, Instrument | null>();
  let meter: Meter | undefined = config.meter;

  const isEnabled = (spec: InstrumentSpec): boolean =>
    config.metrics && (config.genAiConventions || !spec.genAi);

  const instrumentFor = (key: MetricKey, spec: InstrumentSpec): Instrument | undefined => {
    const known = instruments.get(key);
    if (known !== undefined) return known ?? undefined;

    // Resolved on first use, so an SDK registered after this middleware was built is still found.
    meter ??= metricsApi.getMeter(INSTRUMENTATION_NAME);
    const acquired = meter;

    const created = guard<Instrument | null>(
      'createInstrument',
      () =>
        spec.kind === 'histogram'
          ? acquired.createHistogram(spec.name, {
              unit: spec.unit,
              description: spec.description,
              advice: { explicitBucketBoundaries: [...spec.buckets] },
            })
          : acquired.createCounter(spec.name, { unit: spec.unit, description: spec.description }),
      null,
    );

    instruments.set(key, created);
    return created ?? undefined;
  };

  // Models come from requests, so they are the one unbounded attribute. The normalizer bounds
  // it, and a throwing or empty answer keeps the raw model rather than losing the measurement.
  // Bounded, since distinct model strings are unbounded. A Map iterates in insertion order, so
  // the first key is the oldest, and a hit is moved to the end to keep hot models resident.
  const normalizedModelCache = new Map<string, string>();
  const withNormalizedModels = (attributes: Attributes): Attributes => {
    const { normalizeModel } = config;
    if (!normalizeModel) return attributes;

    const result: Attributes = { ...attributes };
    for (const key of MODEL_ATTRIBUTES) {
      const model = result[key];
      if (typeof model !== 'string') continue;

      const cached = normalizedModelCache.get(model);
      if (cached !== undefined) {
        normalizedModelCache.delete(model);
        normalizedModelCache.set(model, cached);
        result[key] = cached;
        continue;
      }

      const normalized: unknown = guard<unknown>(
        'normalizeModel',
        () => normalizeModel(model),
        model,
      );
      const next = isNonEmptyString(normalized) ? normalized : model;
      if (normalizedModelCache.size >= NORMALIZED_MODEL_CACHE_LIMIT) {
        const oldest = normalizedModelCache.keys().next().value;
        if (oldest !== undefined) normalizedModelCache.delete(oldest);
      }
      normalizedModelCache.set(model, next);
      result[key] = next;
    }
    return result;
  };

  const record: Metrics['record'] = (key, value, attributes, context) => {
    guard(
      'recordMetric',
      () => {
        const spec = CATALOG[key];
        if (!isEnabled(spec)) return;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;

        const instrument = instrumentFor(key, spec);
        if (!instrument) return;

        const attrs = withNormalizedModels(attributes);
        if (spec.kind === 'histogram') (instrument as Histogram).record(value, attrs, context);
        else (instrument as Counter).add(value, attrs, context);
      },
      undefined,
    );
  };

  // Target labels go through the provider names option, so cardinality is bounded by config.
  // A missing label or model is left out rather than recorded as an empty value.
  const targetAttributes = (label: string | undefined, model: string | undefined): Attributes => {
    const attrs: Attributes = {};
    if (isNonEmptyString(label)) attrs[VERNLLM_ATTR.provider] = config.targetName(label);
    if (isNonEmptyString(model)) attrs[VERNLLM_ATTR.model] = model;
    return attrs;
  };

  // Spent tokens are spent, so a failed attempt's usage is counted like a successful one's.
  const recordTokens = (usage: TokenUsage, context: Context | undefined): void => {
    const base: Attributes = { [ATTR.operationName]: OPERATION_CHAT };
    if (isNonEmptyString(usage.provider)) {
      base[ATTR.providerName] = config.providerName(usage.provider, usage.model ?? '');
    }
    if (isNonEmptyString(usage.model)) base[ATTR.requestModel] = usage.model;

    record(
      'tokenUsage',
      usage.promptTokens,
      { ...base, [ATTR.tokenType]: TOKEN_TYPE_INPUT },
      context,
    );
    record(
      'tokenUsage',
      usage.completionTokens,
      { ...base, [ATTR.tokenType]: TOKEN_TYPE_OUTPUT },
      context,
    );
  };

  const recordEvent: Metrics['recordEvent'] = (event, context) => {
    switch (event.kind) {
      case 'retry': {
        const target = targetAttributes(event.provider, event.model);
        record(
          'retryCount',
          1,
          {
            ...target,
            [ATTR.errorType]: errorTypeOf(event.error),
            [VERNLLM_ATTR.retryAfterHonored]: event.retryAfterHonored === true,
          },
          context,
        );
        record('retryDelay', event.delayMs / 1000, target, context);
        return;
      }
      case 'fallback':
        record(
          'fallbackCount',
          1,
          {
            [VERNLLM_ATTR.fallbackFrom]: config.targetName(event.from),
            [VERNLLM_ATTR.fallbackTo]: config.targetName(event.to),
          },
          context,
        );
        return;
      case 'rate_limited':
        record(
          'rateLimitWait',
          event.waitedMs / 1000,
          {
            ...targetAttributes(event.provider, event.model),
            [VERNLLM_ATTR.rateLimitReason]: event.reason,
          },
          context,
        );
        return;
      case 'circuit_state':
        record(
          'circuitTransitions',
          1,
          {
            ...targetAttributes(event.provider, event.model),
            [VERNLLM_ATTR.circuitFrom]: event.from,
            [VERNLLM_ATTR.circuitTo]: event.to,
          },
          context,
        );
        return;
      case 'usage':
        recordTokens(event.usage, context);
        return;
      case 'usage_failure':
        recordTokens(event.usage, context);
        record(
          'usageFailureCount',
          1,
          targetAttributes(event.usage.provider, event.usage.model),
          context,
        );
        return;
      case 'middleware':
        return;
    }
  };

  return {
    record,
    // An event is never allowed to fail its handler, whatever shape it arrives in.
    recordEvent: (event, context) =>
      guard('recordEvent', () => recordEvent(event, context), undefined),
  };
}
