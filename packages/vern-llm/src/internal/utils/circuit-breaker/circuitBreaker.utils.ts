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
 * An event reporter that logs, rather than throws, a failing `onEvent`. Kept free of the executor
 * since breakers report before one exists. Also drives `onUsage` and `onUsageFailure` from the
 * usage events, each called independently of `onEvent`.
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
 * A `void` adapter method with remote state may still return a promise nobody awaits, and an
 * unhandled rejection can end the Node process after the call succeeded. Logs the rejection
 * instead, so adapters don't each have to handle it.
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
