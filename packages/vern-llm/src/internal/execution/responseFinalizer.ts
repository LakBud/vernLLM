import { LLMError } from '../../types/errors.js';
import { isToolCallResult } from '../../types/tools.js';
import { normalizeError } from './utils/errors.utils.js';
import { shapeResponse } from './utils/response/responseShape.utils.js';

import type { Logger } from '../../logger.js';
import type {
  CallParams,
  CallWithToolsResult,
  DetectSoftFailure,
  MiddlewareStateBag,
  ThinkingBlock,
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
 * Shapes a complete response and reports the outcome: breaker and usage success when clean, a usage
 * failure otherwise. Breaker failures are decided a layer up, once retries run out.
 * `detectSoftFailure` runs inside the same `try`, so a soft failure takes the normal failure path.
 * With `truncated` set, a parse failure becomes the retryable `response_truncated`. `thinking` is
 * kept only on a tool call result, the one place it must go back.
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
  truncated = false,
  thinking?: ThinkingBlock[],
): T | CallWithToolsResult<T> {
  const { gateway, usageReporter, logger, redactText, parseJson, detectSoftFailure } = deps;

  try {
    const result = withThinking(
      shapeResponse<T>({
        rawContent,
        wireToolCalls,
        params,
        useJson,
        parseJson,
        requestId,
        logger,
        redactText,
      }),
      thinking,
    );

    const softFailureCode = detectSoftFailureSafely(
      detectSoftFailure,
      result,
      {
        requestId,
        model: deps.model,
        providerName: deps.providerName,
        isFallback: deps.isFallback,
        attempt: attempt + 1,
        usage,
      },
      logger,
    );

    if (softFailureCode !== undefined) {
      // `'api'`, not `'validation'`, which is never retried whatever the code. The returned code
      // alone decides retry and breaker counting.
      throw new LLMError('Soft failure detected', 'api', { code: softFailureCode });
    }

    gateway.recordSuccess(attempt, params.signal, state);
    usageReporter.reportSuccess(usage, gateway.buildAttemptContext(attempt, params.signal, state));

    return result;
  } catch (error) {
    // Normalized first so `onUsageFailure` gets an `LLMError`, including for aborts. A soft failure
    // is already one and is reported once, here.
    const normalized = asTruncationError(normalizeError(error, params.signal), truncated);

    if (usage && normalized.type !== 'aborted') {
      usageReporter.reportFailure(
        usage,
        normalized,
        attempt,
        gateway.buildAttemptContext(attempt, params.signal, state),
      );
    }

    throw normalized;
  }
}

/** Adds `thinking` to a tool call result. Any other result is returned as is. */
function withThinking<T>(
  result: T | CallWithToolsResult<T>,
  thinking: ThinkingBlock[] | undefined,
): T | CallWithToolsResult<T> {
  if (!thinking?.length || !isToolCallResult(result)) return result;

  return { ...result, thinking };
}

/**
 * Replaces a parse failure on output that was cut off at `max_tokens`
 * with a `response_truncated` error, keeping the original as `cause`.
 * Anything else, or a response that wasn't cut off, passes through.
 */
function asTruncationError(error: LLMError, truncated: boolean): LLMError {
  if (!truncated || error.type !== 'parse') return error;

  return new LLMError(
    `Response was cut off at max_tokens before it could be parsed: ${error.message}`,
    'parse',
    { code: 'response_truncated', cause: error },
  );
}

/**
 * Runs `detectSoftFailure` and returns its code. A throwing hook is logged and ignored, so it can't
 * fail every call.
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
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
    logger.warn(
      `[VernLLM] detectSoftFailure threw and was ignored, treated as no soft failure: ${message}${stack}`,
    );
    return undefined;
  }
}
