import { readRateLimitHint } from '../../utils/rate-limit/rateLimitHint.utils.js';
import { finalizeResponse } from '../responseFinalizer.js';
import { withTimeout } from '../utils/retry/retry.utils.js';
import {
  finalizeDependencies,
  prepareTargetAttempt,
  type AttemptArgs,
  type AttemptEnvironment,
} from './attemptEnvironment.js';
import { dispatchToProvider } from './providerDispatch.js';

import type { CallWithToolsResult, LLMClient } from '../../../types/index.js';

/**
 * One non-streaming attempt: acquire, dispatch with a timeout, then shape the
 * response. Capacity is acquired per attempt, since a retry is a real request.
 */
export async function executeCall<T>(
  env: AttemptEnvironment,
  args: AttemptArgs<T>,
): Promise<T | CallWithToolsResult<T>> {
  const { params, requestId, attempt, gateway } = args;
  const {
    request,
    model,
    useJson,
    state,
    release: acquiredRelease,
    dispatch,
  } = await prepareTargetAttempt(env, args);
  let release = acquiredRelease;

  try {
    let response!: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;

    await dispatchToProvider(env, dispatch, params.signal, async () => {
      response = await withTimeout(
        (attemptSignal) => env.client.chat.completions.create(request, { signal: attemptSignal }),
        env.timeoutMs,
        params.signal,
      );
    });

    // AIMD's proactive path.
    env.limiter?.reactToRateLimitHint(readRateLimitHint(response));

    // Taken before anything else touches the response, so a later failure
    // still reports usage.
    const usage = env.usageReporter.extract(response, requestId, model);
    const actualTokens = env.usageReporter.actualTokensFor(usage);

    // Raw on purpose: extraction happens inside `finalizeResponse`'s
    // try/catch, so a malformed response is still normalized.
    const choice = response.choices?.[0];
    const rawContent = choice?.message?.content;
    const wireToolCalls = choice?.message?.tool_calls;
    const truncated = choice?.finish_reason === 'length';
    const thinking = choice?.message?.thinking;

    let finalized: T | CallWithToolsResult<T>;

    try {
      finalized = finalizeResponse(
        rawContent,
        wireToolCalls,
        params,
        useJson,
        usage,
        requestId,
        attempt,
        state,
        finalizeDependencies(env, gateway, model),
        truncated,
        thinking,
      );
    } catch (error) {
      // Reconcile usage and free the slot, but never grow AIMD for a
      // response VernLLM itself rejected.
      release?.(actualTokens);
      release = undefined;
      throw error;
    }

    release?.(actualTokens, true);
    release = undefined;

    return finalized;
  } finally {
    // Only reached with a live release when dispatch itself threw.
    release?.();
  }
}
