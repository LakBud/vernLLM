import { LLMError } from '../../../types/errors.js';
import { callHookSafely } from '../logger.utils.js';

import type { Logger } from '../../../logger.js';
import type { VernLLMEvent } from '../../../types/events.js';
import type { TokenUsage } from '../../../types/index.js';
import type { CallExecutor } from '../../execution/callExecutor.js';

/** `onUsage`/`onUsageFailure` from `VernLLMOptions`, plumbed alongside `onEvent` so `makeEventReporter` can drive both off the one dispatch point. */
export interface UsageReporterHooks {
  onUsage?: (usage: TokenUsage) => void;
  onUsageFailure?: (usage: TokenUsage, error: LLMError) => void;
}

/**
 * Builds a `(event) => void` reporter that no-ops when `onEvent` is unset,
 * and otherwise calls it, swallowing and logging any error the handler
 * throws so a broken `onEvent` can't break the call that triggered it.
 * Shared by `buildCircuitBreaker` (which needs to report before any
 * executor exists) and `CallExecutor.reportEvent`, kept independent of the
 * executor for that reason.
 *
 * Also the single place `onUsage`/`onUsageFailure` are driven from: a
 * `'usage'`/`'usage_failure'` event always reaches `onEvent` like any
 * other event, and additionally, separately, reaches the matching plain
 * callback here. Neither call knows the other happened; a throwing
 * `onUsage` can't stop `onEvent` from running or vice versa. This makes
 * the plain options sugar over the event stream, not a second reporting
 * path UsageReporter has to call directly.
 */
export function makeEventReporter(
  onEvent: ((event: VernLLMEvent) => void) | undefined,
  logger: Logger,
  usageHooks: UsageReporterHooks = {},
): (event: VernLLMEvent) => void {
  return (event) => {
    if (onEvent) callHookSafely(logger, 'onEvent', () => onEvent(event));

    if (event.kind === 'usage' && usageHooks.onUsage) {
      callHookSafely(logger, 'onUsage', () => usageHooks.onUsage!(event.usage));
    }

    if (event.kind === 'usage_failure' && usageHooks.onUsageFailure) {
      callHookSafely(logger, 'onUsageFailure', () =>
        usageHooks.onUsageFailure!(event.usage, event.error),
      );
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
 * Some adapter methods are declared `void`, but an adapter whose state is
 * remote (Redis) naturally does its work asynchronously and may hand back a
 * promise anyway. Nobody awaits it, so a rejection would otherwise be an
 * unhandled one, which in Node ends the process after the call it belonged
 * to already succeeded. Reports the rejection through `logger` instead, so
 * no adapter has to get this right for itself. A non promise `result` resolves and is ignored.
 */
export function reportRejection(logger: Logger, message: string, result: unknown): void {
  void Promise.resolve(result).catch((error: unknown) => {
    try {
      logger.error(message, { message: error instanceof Error ? error.message : String(error) });
    } catch {
      // Reporting must never become a second, unhandled rejection: even
      // turning the reason into a string can throw.
    }
  });
}
