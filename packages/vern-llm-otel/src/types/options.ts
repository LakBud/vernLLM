import type { LoggerOption } from '../internal/guard.utils.js';
import type { CaptureContentOptions } from './capture.js';
import type { RecordExceptionsOptions } from './exceptions.js';
import type { GenAiProviderName } from './provider.js';
import type { Attributes, Meter, Tracer } from '@opentelemetry/api';
import type { MiddlewareRef, PreDispatchContext, RequiredMiddlewareRef } from 'vern-llm';

export interface OtelMiddlewareOptions {
  /** Default: the global tracer for this package's instrumentation scope. */
  tracer?: Tracer;
  /** Default: the global meter for this package's instrumentation scope. */
  meter?: Meter;
  /** Maps a VernLLM target label (`primary`, `fallback[0]`, or a `name`) to `gen_ai.provider.name`. */
  providerNames?: Readonly<Record<string, GenAiProviderName>>;
  /** Default true. `false` disables every instrument. */
  metrics?: boolean;
  /**
   * Maps a model name to the value used as a metric attribute, for example to collapse per user
   * fine tuned model names. Sync, guarded, metrics only. Span attributes keep the exact model.
   */
  normalizeModel?: (model: string) => string;
  /**
   * Default true. `false` keeps only `vernllm.*` telemetry: no `gen_ai.*` attributes or metrics,
   * and attempt spans become INTERNAL `vernllm.attempt` spans. Use it when a provider SDK
   * instrumentation already emits GenAI spans and metrics, to avoid double counting.
   */
  genAiConventions?: boolean;
  /** Default false. `true` captures input, output, and system instructions. */
  captureContent?: boolean | CaptureContentOptions;
  /** Extra attributes for the call span, for example a conversation id or tenant. Sync, guarded. */
  attributes?: (ctx: PreDispatchContext) => Attributes | undefined;
  /**
   * Default false. `true` adds an `exception` event to every failed attempt span and to the call
   * span. It carries only the low cardinality error code (never the provider's message, which
   * can echo prompt text) and no stack unless `{ stack: true }` is given.
   */
  recordExceptions?: boolean | RecordExceptionsOptions;
  /** Default false. Emits VernLLM `middleware` events as span events on the call span. */
  middlewareEvents?: boolean;
  /** Same shape as `VernLLMOptions.logger`. Default: a `ConsoleLogger`. */
  logger?: LoggerOption;
  /** Entry name. Default `'otel'`. */
  name?: string;
  /**
   * Transform order, and the order among other `outermost` middleware. Default 1000 when content
   * capture is on, so capture runs after other transforms and sees the request as sent. Otherwise
   * default -1000, so this entry is the first `outermost` claimant and its call span covers the
   * others. The call span is outside every middleware that is not `outermost` either way.
   */
  priority?: number;
  /** Order relative to other middleware, typically a redaction ref, for content capture. */
  runsAfter?: (MiddlewareRef | RequiredMiddlewareRef)[];
}
