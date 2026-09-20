import { normalizeCapture } from './captureOptions.utils.js';
import { normalizeExceptions } from './exceptionOptions.utils.js';
import { normalizeProviderNames } from './providerNames.utils.js';
import { optionalBoolean, optionalFunction } from './validate.utils.js';

import type { OtelMiddlewareOptions } from '../../types/index.js';
import type { ResolvedConfig } from './resolvedConfig.js';

export const DEFAULT_NAME = 'otel';
const PRIORITY_AFTER_OTHERS = 1000;
const PRIORITY_OUTERMOST = -1000;

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

  // Capture has to see the request after redaction, so it takes the last transform slot whatever
  // `runsAfter` says. A ref that fails to resolve is only dropped with a warning by the core, and
  // a lower default would then run capture before the very middleware it was meant to follow.
  // Priority does not affect where the call span sits, since the core orders `outermost` entries
  // by registration. Without capture there is no ordering need, so the value is just low.
  const capturesContent = capture !== undefined && capture.anyGroup;
  const defaultPriority = capturesContent ? PRIORITY_AFTER_OTHERS : PRIORITY_OUTERMOST;

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
