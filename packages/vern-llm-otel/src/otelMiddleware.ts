import { trace, type Tracer } from '@opentelemetry/api';
import {
  createMiddlewareRef,
  createStateKey,
  type CallResult,
  type VernLLMMiddleware,
} from 'vern-llm';

import { createContentCapture } from './internal/content/contentCapture.utils.js';
import { createGuard } from './internal/guard.utils.js';
import { createMetrics } from './internal/metrics/metrics.utils.js';
import { normalizeOptions } from './internal/options/normalizeOptions.utils.js';
import { INSTRUMENTATION_NAME } from './internal/semconv.js';
import { CallTracker } from './internal/tracker/callTracker.js';
import { handleEvent } from './internal/tracker/handleEvent.utils.js';

import type { OtelMiddlewareOptions, TrackerDeps } from './types/index.js';

/** One module level ref, so registering two instances hits the core's duplicate ref check. */
export const otelMiddlewareRef = createMiddlewareRef('otel');

export function otelMiddleware(options?: OtelMiddlewareOptions): VernLLMMiddleware {
  const config = normalizeOptions(options);
  const guard = createGuard(config.logger);
  const metrics = createMetrics(config, guard);

  // Created per factory call, so it can never collide with another instance or a user key.
  const trackerKey = createStateKey<CallTracker>('otel.tracker');

  let tracer: Tracer | undefined;
  const deps: TrackerDeps = {
    config,
    guard,
    metrics,
    getTracer: () => (tracer ??= config.tracer ?? trace.getTracer(INSTRUMENTATION_NAME)),
    content: config.capture ? createContentCapture(config.capture, guard) : undefined,
  };

  // No `enabled` on purpose: a function `enabled` makes the core deliver this entry's events
  // asynchronously, and the token attributes rely on the usage event arriving first.
  return {
    name: config.name,
    ref: otelMiddlewareRef,
    position: 'outermost',
    priority: config.priority,
    runsAfter: config.runsAfter,

    wrap: async (request, next, ctx) => {
      const tracker = guard<CallTracker | undefined>(
        'startCall',
        () => CallTracker.start(deps, ctx, request),
        undefined,
      );
      if (!tracker) return next();

      ctx.state.set(trackerKey, tracker);

      let result: CallResult;
      try {
        result = await tracker.run(next);
      } catch (error) {
        guard('finish', () => tracker.finish({ kind: 'error', error }), undefined);
        // The exact error `next` threw, so callers see what they would without this entry.
        throw error;
      }

      guard('finish', () => tracker.finish({ kind: 'result', result }), undefined);
      return result;
    },

    transform: (request, ctx) => {
      guard('startAttempt', () => ctx.state.get(trackerKey)?.startAttempt(ctx, request), undefined);
      return {};
    },

    onEvent: (event, ctx) => {
      guard('handleEvent', () => handleEvent(event, ctx.state.get(trackerKey), metrics), undefined);
    },
  };
}
