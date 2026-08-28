import { normalizeError } from './utils/errors.utils.js';
import { shapeResponse } from './utils/responseShape.utils.js';

import type { Logger } from '../../logger.js';
import type {
  CallParams,
  CallWithToolsResult,
  MiddlewareStateBag,
  TokenUsage,
  WireToolCall,
} from '../../types/index.js';
import type { BreakerGateway } from './circuitBreakerContext.js';
import type { UsageReporter } from './usageReporter.js';

/** Everything `finalizeResponse` needs beyond the raw response and outcome trackers. */
export interface FinalizeResponseDeps {
  gateway: BreakerGateway;
  usageReporter: UsageReporter;
  logger: Pick<Logger, 'debug'>;
  redactText: (text: string) => string;
  parseJson: (content: string) => unknown;
}

/**
 * Shapes a fully-arrived response via `shapeResponse`, then reports the
 * outcome: a breaker success and a usage success on a clean shape, or a
 * usage failure (never a breaker failure, that's decided one layer up
 * once retries are exhausted) on a normalized, non-aborted error.
 * Normalizes and reports usage failure on error itself, so every caller
 * gets identical error handling without duplicating it.
 */
export function finalizeResponse<T>(
  rawContent: string | null | undefined,
  wireToolCalls: WireToolCall[] | undefined,
  params: CallParams<T>,
  useJson: boolean,
  usage: TokenUsage | undefined,
  requestId: string,
  attempt: number,
  state: MiddlewareStateBag,
  deps: FinalizeResponseDeps,
): T | CallWithToolsResult<T> {
  const { gateway, usageReporter, logger, redactText, parseJson } = deps;

  try {
    const result = shapeResponse<T>({
      rawContent,
      wireToolCalls,
      params,
      useJson,
      parseJson,
      requestId,
      logger,
      redactText,
    });

    gateway.recordSuccess(attempt, params.signal, state);
    usageReporter.reportSuccess(usage);

    return result;
  } catch (error) {
    // Normalized first so onUsageFailure always gets a real LLMError.
    // Also covers aborted signals: normalizeError returns type
    // 'aborted' in that case.
    const normalized = normalizeError(error, params.signal);

    if (usage && normalized.type !== 'aborted') {
      usageReporter.reportFailure(usage, normalized, attempt);
    }

    throw normalized;
  }
}
