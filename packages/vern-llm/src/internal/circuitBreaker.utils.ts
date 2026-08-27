import { CircuitBreaker, type CircuitBreakerOptions } from '../circuitBreaker.js';
import { emitEvent } from './execution/utils/middleware.utils.js';

import type { Logger } from '../logger.js';
import type { VernLLMEvent } from '../types/events.js';
import type { AttemptContext, VernLLMMiddleware } from '../types/index.js';
import type { CallExecutor } from './execution/callExecutor.js';

/**
 * Builds a `(event) => void` reporter that no-ops when `onEvent` is unset,
 * and otherwise calls it, swallowing and logging any error the handler
 * throws so a broken `onEvent` can't break the call that triggered it.
 * Shared by `buildCircuitBreaker` (which needs to report before any
 * executor exists) and `CallExecutor.reportEvent`, kept independent of the
 * executor for that reason.
 */
export function makeEventReporter(
  onEvent: ((event: VernLLMEvent) => void) | undefined,
  logger: Logger,
): (event: VernLLMEvent) => void {
  return (event) => {
    if (!onEvent) return;

    try {
      onEvent(event);
    } catch (error) {
      logger.error('[VernLLM] onEvent failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  };
}

/** Resolves a target index so every circuit-breaker method agrees on what counts as valid. */
export function resolveExecutor(
  executors: CallExecutor[],
  index: number,
  caller: string,
): CallExecutor {
  const executor = executors[index];

  if (!executor) {
    throw new RangeError(
      `${caller}: no target at index ${index} (chain has ${executors.length} target${executors.length === 1 ? '' : 's'})`,
    );
  }

  return executor;
}

/** Warns when `model` can't do anything on this target, so it's never silently ignored. */
export function warnIfModelUnsupported(
  isolateByModel: boolean,
  model: string | undefined,
  caller: string,
  logger: Logger,
): void {
  if (model !== undefined && !isolateByModel) {
    logger.warn(
      `[VernLLM] ${caller}: \`model: '${model}'\` has no effect here. This target's circuitBreaker doesn't have isolateByModel on, so it only tracks one shared circuit regardless of \`model\`. Omit \`model\`, or set \`circuitBreaker.isolateByModel: true\` on this target if per-model tracking is what you want.`,
    );
  }
}

/**
 * Builds the optional circuit breaker for one provider target, wiring its
 * `onStateChange` to emit a `circuit_state` event and chain any
 * caller-supplied `onStateChange`. Returns `undefined` when
 * `circuitBreakerOption` is falsy, matching the option's own semantics.
 *
 * Lives outside `CallExecutor` (and outside `VernLLM`, once this were
 * inlined) because the breaker has to exist *before* the executor it's
 * passed into, so its construction can't be an executor concern.
 * `onEvent` is called directly rather than through the executor for the
 * same reason: nothing executor-shaped exists yet at this point.
 *
 * Takes the specific fields it needs (rather than a full `VernLLMOptions`)
 * so it works identically for the primary target and for each fallback
 * target, which carry their own `circuitBreaker` override alongside the
 * shared `onEvent`/`middleware`.
 */
export function buildCircuitBreaker(
  circuitBreakerOption: boolean | CircuitBreakerOptions | undefined,
  providerName: string,
  defaultModel: string,
  onEvent: ((event: VernLLMEvent) => void) | undefined,
  logger: Logger,
  middleware: VernLLMMiddleware[],
  middlewareTimeoutMs: number,
  isFallback: boolean,
  supportsJsonObjectMode: boolean,
): CircuitBreaker | undefined {
  if (!circuitBreakerOption) return undefined;

  const breakerOptions =
    typeof circuitBreakerOption === 'object' ? circuitBreakerOption : undefined;
  const userOnStateChange = breakerOptions?.onStateChange;

  const reportEvent = makeEventReporter(onEvent, logger);

  return new CircuitBreaker({
    ...breakerOptions,
    onStateChange: (from, to, consecutiveFailures, model, context) => {
      const event: VernLLMEvent = {
        kind: 'circuit_state',
        provider: providerName,
        model: model ?? defaultModel,
        from,
        to,
        consecutiveFailures,
      };

      // `context` is absent only when someone calls `CircuitBreaker`
      // directly, bypassing `VernLLM`.
      if (context) {
        const ctx: AttemptContext = {
          stage: 'attempt',
          requestId: context.requestId,
          requestedProvider: providerName,
          requestedModel: model ?? defaultModel,
          isFallbackAttempt: isFallback,
          attempt: 1,
          capabilities: { supportsJsonObjectMode },
          signal: context.signal,
          state: context.state,
          own: {},
        };

        emitEvent(event, ctx, reportEvent, middleware, middlewareTimeoutMs, logger);
      } else {
        reportEvent(event);
      }

      // A caller-supplied onStateChange would otherwise be silently
      // discarded, since the spread above is overwritten by this
      // property. Chain it instead, same try/catch treatment as every
      // other user-supplied callback so it can't break breaker
      // bookkeeping or the call that triggered it.
      if (!userOnStateChange) return;

      try {
        userOnStateChange(from, to, consecutiveFailures, model, context);
      } catch (error) {
        logger.error('[VernLLM] circuitBreaker.onStateChange failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    },
  });
}
