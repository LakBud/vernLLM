import { LLMError } from '../../types/errors.js';
import { normalizeError } from './utils/errors.utils.js';
import { shapeResponse } from './utils/response/responseShape.utils.js';

import type { Logger } from '../../logger.js';
import type {
  CallParams,
  CallWithToolsResult,
  DetectSoftFailure,
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
  logger: Pick<Logger, 'debug' | 'warn'>;
  redactText: (text: string) => string;
  parseJson: (content: string) => unknown;
  /** See `VernLLMOptions.detectSoftFailure`. Absent when no hook was configured. */
  detectSoftFailure?: DetectSoftFailure;
  providerName: string;
  isFallback: boolean;
  /** The resolved model this attempt actually targeted. */
  model: string;
}

/**
 * Shapes a fully-arrived response via `shapeResponse`, then reports the
 * outcome: a breaker success and a usage success on a clean shape, or a
 * usage failure (never a breaker failure, that's decided one layer up
 * once retries are exhausted) on a normalized, non-aborted error.
 * Normalizes and reports usage failure on error itself, so every caller
 * gets identical error handling without duplicating it.
 *
 * A shape that parsed cleanly still passes through `detectSoftFailure`
 * (when configured) before it's reported as a success. A hook that
 * returns an `LLMErrorCode` throws a normal `LLMError` right here,
 * inside the same `try` shaping errors already throw from, so it flows
 * through the exact same catch/normalize/report path as any other
 * failure, retryable or not, with no separate handling to keep in sync.
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
  const { gateway, usageReporter, logger, redactText, parseJson, detectSoftFailure } = deps;

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

    const softFailureCode = detectSoftFailureSafely(
      detectSoftFailure,
      result,
      {
        requestId,
        model: deps.model,
        providerName: deps.providerName,
        isFallback: deps.isFallback,
        attempt: attempt + 1,
      },
      logger,
    );

    if (softFailureCode !== undefined) {
      // `'api'`, not `'validation'`: `'validation'` is excluded from
      // retry and the breaker at the type level regardless of `code`
      // (see `computeRetryable`), which would make a soft failure
      // never retryable no matter what code is returned. `'api'` is
      // the same type the pre-existing empty-response check already
      // uses, so retryability and breaker-counting are governed by the
      // returned code's own exclusion sets, not overridden here.
      throw new LLMError('Soft failure detected', 'api', { code: softFailureCode });
    }

    gateway.recordSuccess(attempt, params.signal, state);
    usageReporter.reportSuccess(usage);

    return result;
  } catch (error) {
    // Normalized first so onUsageFailure always gets a real LLMError.
    // Also covers aborted signals: normalizeError returns type
    // 'aborted' in that case. A soft failure thrown above is already a
    // real LLMError, so normalizeError hands the same instance back
    // unchanged and it's reported exactly once, right here, same as any
    // other failure.
    const normalized = normalizeError(error, params.signal);

    if (usage && normalized.type !== 'aborted') {
      usageReporter.reportFailure(usage, normalized, attempt);
    }

    throw normalized;
  }
}

/**
 * Runs `detectSoftFailure` (if configured) and returns the code it
 * reports, or `undefined` for a real success. A throwing hook is caught,
 * logged, and treated the same as `undefined`: a hook that can't run
 * shouldn't fail every call it's attached to.
 */
function detectSoftFailureSafely<T>(
  detectSoftFailure: DetectSoftFailure | undefined,
  result: T | CallWithToolsResult<T>,
  meta: Parameters<DetectSoftFailure>[1],
  logger: Pick<Logger, 'warn'>,
) {
  if (!detectSoftFailure) return undefined;

  try {
    return detectSoftFailure(result, meta);
  } catch (error) {
    logger.warn(
      `detectSoftFailure threw and was ignored, treated as no soft failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}
