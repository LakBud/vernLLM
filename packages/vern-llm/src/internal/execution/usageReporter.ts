import { toTokenUsage } from './utils/response/usage.utils.js';

import type { Logger } from '../../logger.js';
import type { LLMError } from '../../types/errors.js';
import type { VernLLMEvent } from '../../types/events.js';
import type { AttemptContext, LLMClient, TokenUsage } from '../../types/index.js';

/** Everything one target's `UsageReporter` needs beyond the response/error being reported on. */
export interface UsageReporterOptions {
  providerName: string;
  /** True for every target after the primary. Stamped onto every reported `TokenUsage`. */
  isFallback: boolean;
  maxRetries: number;
  /**
   * Reports a `'usage'`/`'usage_failure'` event through the same
   * instance-level reporter and middleware fan-out every other event
   * uses (see `emitEvent`). `VernLLMOptions.onUsage`/`onUsageFailure`
   * are driven from this same event by `makeEventReporter`, not called
   * directly here: `UsageReporter` has exactly one way to report
   * usage, not two.
   */
  emitEvent: (event: VernLLMEvent, ctx: AttemptContext) => void;
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
  /** Reports token usage for a successful call as a `'usage'` event. `ctx` is this attempt's `AttemptContext`, used to fan the event out to middleware and to `onEvent`/`onUsage`. */
  reportSuccess(usage: TokenUsage | undefined, ctx: AttemptContext): void;
  /**
   * Reports token usage spent on an attempt that then failed, as a
   * `'usage_failure'` event, so it isn't dropped alongside the error.
   * Covers any error thrown after usage extraction, since all of them
   * happen only after a response (real spend) already arrived.
   */
  reportFailure(
    usage: TokenUsage,
    error: LLMError,
    attempt: number,
    ctx: AttemptContext,
    terminal?: boolean,
  ): void;
}

export function createUsageReporter(options: UsageReporterOptions): UsageReporter {
  const { providerName, isFallback, maxRetries, emitEvent, logger } = options;

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

  function reportSuccess(usage: TokenUsage | undefined, ctx: AttemptContext): void {
    if (!usage) return;

    emitEvent({ kind: 'usage', requestId: usage.requestId, usage }, ctx);
  }

  function reportFailure(
    usage: TokenUsage,
    error: LLMError,
    attempt: number,
    ctx: AttemptContext,
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

    emitEvent({ kind: 'usage_failure', requestId: usage.requestId, usage, error }, ctx);
  }

  return { extract, actualTokensFor, reportSuccess, reportFailure };
}
