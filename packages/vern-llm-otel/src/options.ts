import type { LoggerOption } from './guard.js';
import type { Attributes, Meter, Tracer } from '@opentelemetry/api';
import type {
  MiddlewareRef,
  PreDispatchContext,
  RequiredMiddlewareRef,
  WireCallRequest,
} from 'vern-llm';

/** Well known values with autocomplete, any string is accepted. */
export type GenAiProviderName =
  | 'openai'
  | 'anthropic'
  | 'aws.bedrock'
  | 'azure.ai.openai'
  | 'azure.ai.inference'
  | 'gcp.gemini'
  | 'gcp.vertex_ai'
  | 'gcp.gen_ai'
  | 'groq'
  | 'mistral_ai'
  | 'deepseek'
  | 'x_ai'
  | 'cohere'
  | 'perplexity'
  | 'ibm.watsonx.ai'
  | 'moonshot_ai'
  | (string & {});

export interface CaptureContentOptions {
  /** Default true. */
  input?: boolean;
  /** Default true. */
  output?: boolean;
  /** Default true. */
  systemInstructions?: boolean;
  /** Default false, can be large. */
  toolDefinitions?: boolean;
  /** Max characters per captured attribute. Positive integer or Infinity. Default 8192. */
  maxLength?: number;
  /** Runs on every text piece before it is recorded. */
  redact?: (text: string) => string;
  /**
   * Decides, once per logical call, whether content is captured for that call. Sync only.
   * Only a return value of exactly `true` enables capture. Throwing, returning anything else,
   * or returning a promise means no capture (fail closed). Receives the unredacted request,
   * so do not log or forward it.
   */
  when?: (ctx: PreDispatchContext, request: Readonly<WireCallRequest>) => boolean;
}

export interface RecordExceptionsOptions {
  /**
   * Default false. Adds the error's stack trace to the exception event. A stack's first line
   * carries the error message, which can echo prompt text, so this is a separate opt in.
   */
  stack?: boolean;
}

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
   * Transform order. Default 1000 when content capture is on and `runsAfter` is empty, so capture
   * runs after other transforms. Otherwise default -1000, so this entry is the first `outermost`
   * claimant and its call span covers the others.
   */
  priority?: number;
  /** Order relative to other middleware, typically a redaction ref, for content capture. */
  runsAfter?: (MiddlewareRef | RequiredMiddlewareRef)[];
}

export const DEFAULT_MAX_LENGTH = 8192;
export const DEFAULT_NAME = 'otel';
const PRIORITY_AFTER_OTHERS = 1000;
const PRIORITY_OUTERMOST = -1000;

export interface ResolvedCapture {
  input: boolean;
  output: boolean;
  systemInstructions: boolean;
  toolDefinitions: boolean;
  maxLength: number;
  redact: ((text: string) => string) | undefined;
  when: ((ctx: PreDispatchContext, request: Readonly<WireCallRequest>) => boolean) | undefined;
  /** False when every group is off, so nothing is ever recorded and `when` is never consulted. */
  anyGroup: boolean;
}

/** Every option validated and defaulted once, so no other file repeats a default. */
export interface ResolvedConfig {
  tracer: Tracer | undefined;
  meter: Meter | undefined;
  metrics: boolean;
  genAiConventions: boolean;
  normalizeModel: ((model: string) => string) | undefined;
  attributes: ((ctx: PreDispatchContext) => Attributes | undefined) | undefined;
  middlewareEvents: boolean;
  /** `undefined` when exception recording is off. */
  exceptions: { stack: boolean } | undefined;
  logger: LoggerOption | undefined;
  name: string;
  priority: number;
  runsAfter: (MiddlewareRef | RequiredMiddlewareRef)[];
  /** `undefined` when content capture is off. */
  capture: ResolvedCapture | undefined;
  /** Mapped `gen_ai.provider.name`, falling back to the raw target label. */
  providerName(label: string): string;
}

export function normalizeOptions(options: OtelMiddlewareOptions | undefined): ResolvedConfig {
  const opts: OtelMiddlewareOptions = options === undefined ? {} : options;
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new Error('otelMiddleware: options must be an object');
  }

  optionalBoolean(opts.metrics, 'metrics');
  optionalBoolean(opts.genAiConventions, 'genAiConventions');
  optionalBoolean(opts.middlewareEvents, 'middlewareEvents');
  optionalFunction(opts.normalizeModel, 'normalizeModel');
  optionalFunction(opts.attributes, 'attributes');

  // Validated either way, but not used without GenAI conventions: the content attributes are
  // `gen_ai.*` ones, and that mode promises to emit none.
  const validatedCapture = normalizeCapture(opts.captureContent);
  const capture = opts.genAiConventions === false ? undefined : validatedCapture;
  const exceptions = normalizeExceptions(opts.recordExceptions);
  const providerNames = normalizeProviderNames(opts.providerNames);

  if (opts.name !== undefined && (typeof opts.name !== 'string' || opts.name.trim() === '')) {
    throw new Error('otelMiddleware: name must be a non-empty string');
  }
  if (opts.priority !== undefined && !Number.isFinite(opts.priority)) {
    throw new Error('otelMiddleware: priority must be a finite number');
  }
  if (opts.runsAfter !== undefined && !Array.isArray(opts.runsAfter)) {
    throw new Error('otelMiddleware: runsAfter must be an array');
  }
  if (
    opts.logger !== undefined &&
    opts.logger !== 'silent' &&
    (typeof opts.logger !== 'object' || opts.logger === null)
  ) {
    throw new Error("otelMiddleware: logger must be a Logger or 'silent'");
  }

  // Entries are left for the core to validate, so its own error names the bad ref.
  const runsAfter = [...(opts.runsAfter ?? [])];

  // Capture has to see the request after redaction, so it defaults to the last transform slot
  // unless an explicit ordering was given. Without capture there is no ordering need, and the
  // low value makes this the first `outermost` claimant so the call span covers the others.
  const capturesContent = capture !== undefined && capture.anyGroup;
  const defaultPriority =
    capturesContent && runsAfter.length === 0 ? PRIORITY_AFTER_OTHERS : PRIORITY_OUTERMOST;

  return {
    tracer: opts.tracer,
    meter: opts.meter,
    metrics: opts.metrics ?? true,
    genAiConventions: opts.genAiConventions ?? true,
    normalizeModel: opts.normalizeModel,
    attributes: opts.attributes,
    middlewareEvents: opts.middlewareEvents ?? false,
    exceptions,
    logger: opts.logger,
    name: opts.name ?? DEFAULT_NAME,
    priority: opts.priority ?? defaultPriority,
    runsAfter,
    capture,
    providerName: (label) => providerNames.get(label) ?? label,
  };
}

function normalizeCapture(
  option: boolean | CaptureContentOptions | undefined,
): ResolvedCapture | undefined {
  if (option === undefined || option === false) return undefined;

  if (option !== true && (typeof option !== 'object' || option === null || Array.isArray(option))) {
    throw new Error('otelMiddleware: captureContent must be a boolean or an object');
  }

  const c: CaptureContentOptions = option === true ? {} : option;

  optionalBoolean(c.input, 'captureContent.input');
  optionalBoolean(c.output, 'captureContent.output');
  optionalBoolean(c.systemInstructions, 'captureContent.systemInstructions');
  optionalBoolean(c.toolDefinitions, 'captureContent.toolDefinitions');
  optionalFunction(c.redact, 'captureContent.redact');
  optionalFunction(c.when, 'captureContent.when');

  // Not `??`: an explicit null is a mistake to report, not a request for the default.
  const maxLength = c.maxLength === undefined ? DEFAULT_MAX_LENGTH : c.maxLength;
  const validLength =
    typeof maxLength === 'number' &&
    (maxLength === Number.POSITIVE_INFINITY || (Number.isInteger(maxLength) && maxLength > 0));
  if (!validLength) {
    throw new Error(
      'otelMiddleware: captureContent.maxLength must be a positive integer or Infinity',
    );
  }

  const resolved = {
    input: c.input ?? true,
    output: c.output ?? true,
    systemInstructions: c.systemInstructions ?? true,
    toolDefinitions: c.toolDefinitions ?? false,
  };

  return {
    ...resolved,
    maxLength,
    redact: c.redact,
    when: c.when,
    anyGroup: Object.values(resolved).some(Boolean),
  };
}

function normalizeExceptions(
  option: boolean | RecordExceptionsOptions | undefined,
): { stack: boolean } | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return { stack: false };

  if (typeof option !== 'object' || option === null || Array.isArray(option)) {
    throw new Error('otelMiddleware: recordExceptions must be a boolean or an object');
  }
  optionalBoolean(option.stack, 'recordExceptions.stack');

  return { stack: option.stack ?? false };
}

function normalizeProviderNames(
  names: Readonly<Record<string, GenAiProviderName>> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (names === undefined) return map;

  if (typeof names !== 'object' || names === null || Array.isArray(names)) {
    throw new Error('otelMiddleware: providerNames must be an object');
  }

  for (const [label, value] of Object.entries(names)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`otelMiddleware: providerNames["${label}"] must be a non-empty string`);
    }
    map.set(label, value);
  }

  return map;
}

function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`otelMiddleware: ${name} must be a boolean`);
  }
}

function optionalFunction(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new Error(`otelMiddleware: ${name} must be a function`);
  }
}
