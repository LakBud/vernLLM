import {
  createMiddlewareRef,
  createStateKey,
  isStreamResult,
  type CallResult,
  type VernLLMMiddleware,
} from 'vern-llm';

import { ErrorGrouper } from './internal/detectors/errorGrouper.js';
import { createGuard } from './internal/guard.utils.js';
import { normalizeOptions } from './internal/options/normalizeOptions.utils.js';
import { createFinalize } from './internal/pipeline/finalize.js';
import { applyEvent } from './internal/recorder/applyEvent.utils.js';
import { CallRecorder } from './internal/recorder/callRecorder.js';
import { Scheduler } from './internal/scheduler.js';
import { SeriesRegistry } from './internal/stats/seriesRegistry.js';
import { createStatsApi } from './internal/stats/statsApi.utils.js';

import type { BreakerEntry, LoggerMiddlewareOptions, StatsApi } from './types/index.js';

/** One module level ref, so registering two instances hits the core's duplicate ref check. */
export const loggerMiddlewareRef = createMiddlewareRef('logger');

/** The middleware plus the rolling stats it keeps. */
export type LoggerMiddleware = VernLLMMiddleware & {
  readonly stats: StatsApi;
  /** Stops the timer and writes any pending error groups. Call it on shutdown. */
  dispose(): void;
};

export function loggerMiddleware(options?: LoggerMiddlewareOptions): LoggerMiddleware {
  const config = normalizeOptions(options);
  const guard = createGuard(config.logger);
  const registry = new SeriesRegistry(config, guard);
  const groups = new ErrorGrouper(config.window.durationMs);
  const finalize = createFinalize(config, guard, registry, groups);
  const scheduler = new Scheduler({
    config,
    guard,
    registry,
    groups,
    write: (entry, level) => finalize(entry, level),
  });

  // Created per factory call, so it can never collide with another instance or a user key.
  const recorderKey = createStateKey<CallRecorder>('logger.recorder');

  /** Writes the record when the stream settles. The stream itself is only observed. */
  const observeStream = (
    recorder: CallRecorder,
    result: CallResult,
    stream: { finalResult: PromiseLike<unknown> },
  ): void => {
    const settle = (outcome: Parameters<CallRecorder['finish']>[0]) => {
      const record = guard('finish', () => recorder.finish(outcome), undefined);
      if (record) finalize(record);
    };

    try {
      void stream.finalResult.then(
        (value) =>
          settle({ kind: 'result', result: { value, meta: result.meta, cache: result.cache } }),
        (error: unknown) => settle({ kind: 'error', error }),
      );
    } catch (error) {
      guard.report('observeStream', error);
      // Nothing will ever settle this call, so record it as it stands rather than lose it.
      settle({ kind: 'result', result });
    }
  };

  // No `enabled` on purpose: a function `enabled` makes the core deliver `onEvent`
  // asynchronously, and the record relies on `usage` landing before the call finishes.
  return {
    stats: createStatsApi(registry),
    dispose: () => scheduler.dispose(),
    name: config.name,
    ref: loggerMiddlewareRef,
    // Outermost, so the record sees the whole call, including rejections.
    position: 'outermost',

    wrap: async (_request, next, ctx) => {
      guard('scheduler.start', () => scheduler.ensureStarted(), undefined);
      const recorder = guard<CallRecorder | undefined>(
        'startCall',
        () => CallRecorder.start(ctx, config, guard),
        undefined,
      );
      if (!recorder) return next();

      try {
        ctx.state.set(recorderKey, recorder);
      } catch (error) {
        guard.report('registerRecorder', error);
        return next();
      }

      let result: CallResult;
      try {
        result = await next();
      } catch (error) {
        const record = guard('finish', () => recorder.finish({ kind: 'error', error }), undefined);
        if (record) finalize(record);
        // The exact error `next` threw, so callers see what they would without this entry.
        throw error;
      }

      if (isStreamResult(result.value)) {
        guard('markStream', () => recorder.markStream(), undefined);
        observeStream(recorder, result, result.value);
        return result;
      }

      const record = guard('finish', () => recorder.finish({ kind: 'result', result }), undefined);
      if (record) finalize(record);
      return result;
    },

    dispatch: async (_request, next, ctx) => {
      const recorder = guard('readRecorder', () => ctx.state.get(recorderKey), undefined);
      if (!recorder) return next();

      guard('openAttempt', () => recorder.openAttempt(ctx), undefined);
      try {
        await next();
      } catch (error) {
        guard('attemptFailed', () => recorder.attemptFailed(error), undefined);
        throw error;
      }
      guard('responded', () => recorder.responded(), undefined);
    },

    onEvent: (event, ctx) => {
      guard(
        'handleEvent',
        () => {
          const recorder = ctx?.state.get(recorderKey);
          if (recorder) {
            applyEvent(recorder, event, config.keepCustomEvent);
            return;
          }

          // A breaker change outside any call has no record to join.
          if (event.kind === 'circuit_state') {
            const entry: BreakerEntry = {
              kind: 'breaker',
              v: 1,
              provider: event.provider,
              model: event.model,
              from: event.from,
              to: event.to,
              consecutiveFailures: event.consecutiveFailures,
            };
            finalize(entry, event.to === 'open' ? 'warn' : 'info');
          }
        },
        undefined,
      );
    },
  };
}
