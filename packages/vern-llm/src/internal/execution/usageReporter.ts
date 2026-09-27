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
   * Reports `'usage'` and `'usage_failure'` events through the shared event path. `onUsage` and
   * `onUsageFailure` are driven from those events, so usage has one reporting route.
   */
  emitEvent: (event: VernLLMEvent, ctx: AttemptContext) => void;
  logger: Logger;
}

export interface UsageReporter {
  /**
   * `TokenUsage` from a raw response, if reported. Independent of the rest of the body, so a
   * malformed response can still yield usage.
   */
  extract(
    response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>,
    requestId: string,
    model: string,
  ): TokenUsage | undefined;
  /**
   * The token count to reconcile the limiter with: `totalTokens`, else prompt plus completion.
   * `undefined` when missing or all zero, so the limiter keeps its estimate.
   */
  actualTokensFor(usage: TokenUsage | undefined): number | undefined;
  /** Reports token usage for a successful call as a `'usage'` event. `ctx` is this attempt's `AttemptContext`, used to fan the event out to middleware and to `onEvent`/`onUsage`. */
  reportSuccess(usage: TokenUsage | undefined, ctx: AttemptContext): void;
  /**
   * Reports usage spent on an attempt that then failed, as `'usage_failure'`, so it isn't lost with
   * the error.
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

    const total = usage.totalTokens || usage.promptTokens + usage.completionTokens;

    // A real request always spends prompt tokens, so an all zero report
    // means the provider sent no usage. Reconciling against it would
    // refund the whole estimate for tokens that were actually spent.
    return total === 0 ? undefined : total;
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
