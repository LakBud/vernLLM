import { toTokenUsage } from './utils/response/usage.utils.js';

import type { Logger } from '../../logger.js';
import type { LLMError } from '../../types/errors.js';
import type { LLMClient, TokenUsage, VernLLMEvent } from '../../types/index.js';

/** Everything one target's `UsageReporter` needs beyond the response/error being reported on. */
export interface UsageReporterOptions {
  providerName: string;
  /** True for every target after the primary. Stamped onto every reported `TokenUsage`. */
  isFallback: boolean;
  maxRetries: number;
  onUsage?: (usage: TokenUsage) => void;
  onUsageFailure?: (usage: TokenUsage, error: LLMError) => void;
  /** Emits a `usage` event alongside `onUsage`, on success only. */
  reportEvent?: (event: VernLLMEvent) => void;
  logger: Logger;
}

export interface UsageReporter {
  /**
   * Pulls `TokenUsage` out of a raw response, if the provider reported it.
   * Extraction doesn't depend on what happens to the response afterward,
   * so a malformed body can still yield usage if the provider's usage
   * block itself came through intact.
   */
  extract(
    response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>,
    requestId: string,
    model: string,
  ): TokenUsage | undefined;
  /**
   * The token count to reconcile the rate limiter against for a finished
   * attempt: `totalTokens` when reported, otherwise the sum of prompt and
   * completion tokens, matching `reportFailure`'s own fallback for a
   * hand-rolled client that reports the parts but omits the total.
   */
  actualTokensFor(usage: TokenUsage | undefined): number | undefined;
  /** Reports token usage for a successful call, swallowing and logging any error `onUsage` throws. */
  reportSuccess(usage: TokenUsage | undefined): void;
  /**
   * Reports token usage spent on an attempt that then failed, so it isn't
   * dropped alongside the error. Covers any error thrown after usage
   * extraction, since all of them happen only after a response (real
   * spend) already arrived. Swallows and logs any error `onUsageFailure`
   * itself throws.
   */
  reportFailure(usage: TokenUsage, error: LLMError, attempt: number, terminal?: boolean): void;
}

export function createUsageReporter(options: UsageReporterOptions): UsageReporter {
  const { providerName, isFallback, maxRetries, onUsage, onUsageFailure, reportEvent, logger } =
    options;

  function extract(
    response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>,
    requestId: string,
    model: string,
  ): TokenUsage | undefined {
    if (!response.usage) return undefined;

    return toTokenUsage(response.usage, { requestId, model, providerName, isFallback });
  }

  function actualTokensFor(usage: TokenUsage | undefined): number | undefined {
    if (!usage) return undefined;
    return usage.totalTokens || usage.promptTokens + usage.completionTokens;
  }

  function reportSuccess(usage: TokenUsage | undefined): void {
    if (!usage) return;

    if (reportEvent) {
      reportEvent({
        kind: 'usage',
        requestId: usage.requestId,
        provider: usage.provider ?? providerName,
        model: usage.model,
        usage,
      });
    }

    if (!onUsage) return;

    try {
      onUsage(usage);
    } catch (error) {
      logger.error('[VernLLM] onUsage failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  function reportFailure(
    usage: TokenUsage,
    error: LLMError,
    attempt: number,
    terminal = false,
  ): void {
    // Falls back to promptTokens + completionTokens if totalTokens is 0
    // (e.g. a hand-rolled client that omits the total), so the log
    // doesn't understate real spend.
    const displayTokens = usage.totalTokens || usage.promptTokens + usage.completionTokens;

    // A mid-stream failure is terminal for that call (no further attempts
    // for this stream), unlike a stream-open failure where attempt N+1 may
    // still follow. Label them differently so the log doesn't imply a
    // retry that isn't coming.
    const attemptText = terminal
      ? 'mid-stream failure (terminal, no further attempts)'
      : `attempt ${attempt + 1}/${maxRetries + 1}`;

    logger.warn(
      `[VernLLM:${usage.requestId}] usage failure, ${attemptText}: ` +
        `type=${error.type} tokens=${displayTokens}`,
    );

    if (!onUsageFailure) return;

    try {
      onUsageFailure(usage, error);
    } catch (hookError) {
      logger.error('[VernLLM] onUsageFailure failed', {
        message: hookError instanceof Error ? hookError.message : 'unknown',
      });
    }
  }

  return { extract, actualTokensFor, reportSuccess, reportFailure };
}
