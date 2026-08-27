import { LLMError } from '../../types/errors.js';
import { FallbackExhaustedError } from '../../types/fallback.js';
import { normalizeError } from './utils/errors.utils.js';
import { emitEvent } from './utils/middleware.utils.js';

import type { Logger } from '../../logger.js';
import type {
  AttemptContext,
  CallParams,
  CallResult,
  CallWithToolsResult,
  FallbackAttempt,
  FallbackOn,
  MiddlewareStateBag,
  StreamChunk,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../types/index.js';
import type { CallExecutor } from './callExecutor.js';

/**
 * Everything `runFallbackChain`/`executeLogicalCall`/
 * `executeLogicalStreamCall` need from `VernLLM` itself, gathered into
 * one small object so those functions can live outside the class as
 * plain, independently testable functions instead of private methods.
 */
export interface LogicalCallDependencies {
  /** One `CallExecutor` per provider target: index 0 is the primary, everything after it is a `fallback` target, in the order declared. */
  executors: CallExecutor[];
  /** Decides whether a failed target is followed by the next one or the chain stops. See `VernLLMOptions['fallbackOn']`. */
  fallbackOn: FallbackOn;
  /** Reports a `'fallback'` event when the chain moves to the next target. */
  reportEvent: (event: VernLLMEvent) => void;
  /** See `VernLLMOptions.middleware`. Already sorted by `priority`. */
  middleware: VernLLMMiddleware[];
  /** See `VernLLMOptions.middlewareTimeoutMs`. */
  middlewareTimeoutMs: number;
  logger: Logger;
}

/**
 * The outcome of walking `runFallbackChain`: the winning target's own
 * result, which target answered, that target's index within
 * `LogicalCallDependencies.executors`, and how many real attempts
 * (retries included) that target itself made.
 */
export interface FallbackChainOutcome<TResult> {
  result: TResult;
  executor: CallExecutor;
  index: number;
  attemptCount: number;
}

/**
 * Walks `dependencies.executors` in order, starting from the primary
 * target, calling `attempt` against each until one succeeds or every
 * target has failed. `skipBreakerCheckForFirst` mirrors the sole-target
 * breaker precheck `VernLLM.call()` already performs before usage is
 * reserved: rechecking the same executor's breaker here would either
 * falsely see a half-open trial slot as already claimed, or double-claim
 * a slot no concurrent caller actually has.
 *
 * Throws the lone failure directly when only one target was ever tried
 * (so a single-target caller's error shape is unchanged from
 * pre-fallback behavior), or a `FallbackExhaustedError` carrying every
 * attempt once more than one target has failed.
 */
export async function runFallbackChain<R>(
  dependencies: LogicalCallDependencies,
  params: Pick<CallParams<unknown>, 'model' | 'signal'>,
  requestId: string,
  middlewareState: MiddlewareStateBag,
  attempt: (executor: CallExecutor, onAttempt: () => void) => Promise<R>,
  skipBreakerCheckForFirst = false,
): Promise<FallbackChainOutcome<R>> {
  const fallbackAttempts: FallbackAttempt[] = [];

  for (let targetIndex = 0; targetIndex < dependencies.executors.length; targetIndex++) {
    const executor = dependencies.executors[targetIndex]!;
    const startedAt = Date.now();
    let attemptCount = 0;

    try {
      // Already checked once, before usage was reserved, when this is
      // the sole target (see `VernLLM.call()`). `assertBreakerClosed`
      // claims a half-open trial slot as a side effect on a
      // non-throwing call, so it must run exactly once per logical
      // call: checking it again here for the same executor could
      // either falsely see "trial already in flight" (from the check
      // that just claimed it) or double-claim a slot no concurrent
      // caller actually has.
      if (!(targetIndex === 0 && skipBreakerCheckForFirst)) {
        executor.assertBreakerClosed(params.model, {
          requestId,
          state: middlewareState,
          signal: params.signal,
        });
      }

      const result = await attempt(executor, () => {
        attemptCount += 1;
      });
      return { result, executor, index: targetIndex, attemptCount };
    } catch (error) {
      const normalizedError = normalizeError(error, params.signal);

      fallbackAttempts.push({
        index: targetIndex - 1,
        provider: executor.providerName,
        model: params.model ?? executor.model,
        // `.toSnapshot()`: this target's own `attempts` (from its own
        // retries, already snapshots per `CallExecutor`) come along
        // for free since `toSnapshot()` copies them as-is.
        error: normalizedError.toSnapshot(),
      });

      const isLastTarget = targetIndex === dependencies.executors.length - 1;
      // Always consult fallbackOn, including on the last target, so it
      // sees every failure and callers who log or count from inside it
      // get a complete picture. The chain still stops once the last
      // target fails regardless of what fallbackOn returns: there is
      // no next executor to fall over to.
      const policyDecision = dependencies.fallbackOn(normalizedError, { isLastTarget });
      const decision = isLastTarget ? 'stop' : policyDecision;

      if (decision === 'stop') {
        // A lone target (or a chain that stopped on its first failure)
        // throws its own error, unchanged from pre-fallback behavior.
        throw fallbackAttempts.length > 1
          ? new FallbackExhaustedError(fallbackAttempts)
          : normalizedError;
      }

      const nextExecutor = dependencies.executors[targetIndex + 1]!;
      const failedModel = params.model ?? executor.model;

      // `ctx` describes the target that just failed (`from`), not the
      // one about to be tried next.
      const ctx: AttemptContext = {
        stage: 'attempt',
        requestId,
        requestedProvider: executor.providerName,
        requestedModel: failedModel,
        isFallbackAttempt: targetIndex > 0,
        // `attemptCount` stays `0` when `assertBreakerClosed` throws
        // before `attempt()` ever runs; `AttemptContext.attempt` is
        // documented as 1-based, so floor it here.
        attempt: attemptCount || 1,
        capabilities: { supportsJsonObjectMode: executor.jsonObjectModeSupported },
        signal: params.signal,
        state: middlewareState,
        own: {},
      };

      emitEvent(
        {
          kind: 'fallback',
          requestId,
          from: executor.providerName,
          to: nextExecutor.providerName,
          fromIndex: targetIndex - 1,
          toIndex: targetIndex,
          error: normalizedError,
          elapsedMs: Date.now() - startedAt,
        },
        ctx,
        dependencies.reportEvent,
        dependencies.middleware,
        dependencies.middlewareTimeoutMs,
        dependencies.logger,
      );
    }
  }

  // Unreachable: the loop above always either returns or throws before
  // running out of targets (the last iteration's `isLastTarget` forces
  // a throw). Kept only to satisfy the return type.
  throw new LLMError('No provider targets configured', 'invalid_params');
}

/**
 * The fallback-chain + retry core of one logical, non-streaming call,
 * with no middleware `wrap` of its own: callers (`VernLLM.call()`
 * directly, or `cachedCall()`'s cache-miss path) each wrap this in
 * exactly one `runOperation` themselves, so a value never passes through
 * `wrap` twice.
 */
export async function executeLogicalCall<T>(
  dependencies: LogicalCallDependencies,
  params: CallParams<T>,
  requestId: string,
  soleTarget: boolean,
  middlewareState: MiddlewareStateBag,
): Promise<CallResult<T | CallWithToolsResult<T>>> {
  const fallbackChainOutcome = await runFallbackChain(
    dependencies,
    params,
    requestId,
    middlewareState,
    (executor, onAttempt) => executor.run(params, requestId, onAttempt, middlewareState),
    soleTarget,
  );

  const meta = {
    provider: fallbackChainOutcome.executor.providerName,
    model: params.model ?? fallbackChainOutcome.executor.model,
    fallbackIndex: fallbackChainOutcome.index - 1,
    usedFallback: fallbackChainOutcome.index > 0,
    attempts: fallbackChainOutcome.attemptCount,
  };

  if (params.meta) {
    params.meta.current = meta;
  }

  return { value: fallbackChainOutcome.result, meta };
}

/** Streaming counterpart to `executeLogicalCall`. See its docs. */
export async function executeLogicalStreamCall<T>(
  dependencies: LogicalCallDependencies,
  params: CallParams<T>,
  requestId: string,
  soleTarget: boolean,
  middlewareState: MiddlewareStateBag,
): Promise<
  CallResult<{
    chunks: AsyncIterable<StreamChunk>;
    finalResult: Promise<T | CallWithToolsResult<T>>;
  }>
> {
  const fallbackChainOutcome = await runFallbackChain(
    dependencies,
    params,
    requestId,
    middlewareState,
    (executor, onAttempt) => executor.runStream(params, requestId, onAttempt, middlewareState),
    soleTarget,
  );

  const streamResult = fallbackChainOutcome.result;

  const meta = {
    provider: fallbackChainOutcome.executor.providerName,
    model: params.model ?? fallbackChainOutcome.executor.model,
    fallbackIndex: fallbackChainOutcome.index - 1,
    usedFallback: fallbackChainOutcome.index > 0,
    attempts: fallbackChainOutcome.attemptCount,
  };

  // `params` here is the same object `VernLLM.call()` received from the
  // caller, not a clone, so this write is visible on the caller's own
  // `meta` out-parameter too: by the time `call()` finishes awaiting this
  // function and returns `{ chunks, finalResult }`, `params.meta.current`
  // has already been set, even though the caller didn't have to unwrap a
  // `wrap`'s `next()` to get it.
  if (params.meta) {
    params.meta.current = meta;
  }

  return { value: streamResult, meta };
}
