import { LLMError } from '../../types/errors.js';
import { FallbackExhaustedError } from '../../types/fallback.js';
import { middlewareLabels } from '../resolveMiddlewareOrder.js';
import { normalizeError } from './utils/errors.utils.js';
import { emitEvent } from './utils/middleware/middleware.utils.js';

import type { Logger } from '../../logger.js';
import type {
  AttemptContext,
  CallParams,
  CallMeta,
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
  /** See `VernLLMOptions.middleware`. Already in `transform`/`onEvent` order: `priority`, with `runsAfter`/`runsBefore` resolved first. */
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
  /** The model the winning target actually ran, see `modelForTarget`. */
  model: string;
}

/**
 * The per call `model` override for the target at `targetIndex`, or
 * `undefined` so the target uses its own configured model. The override
 * names a model on the primary's provider, so sending it to a fallback
 * on another provider (say `gpt-4o-mini` to Anthropic) can only fail.
 */
export function modelForTarget(
  params: Pick<CallParams<unknown>, 'model'>,
  targetIndex: number,
): string | undefined {
  return targetIndex === 0 ? params.model : undefined;
}

/** `params` as the target at `targetIndex` should see it, see `modelForTarget`. */
export function paramsForTarget<P extends Pick<CallParams<unknown>, 'model'>>(
  params: P,
  targetIndex: number,
): P {
  if (targetIndex === 0 || params.model === undefined) return params;
  return { ...params, model: undefined };
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
 * A per call `model` override applies to the primary only. Every
 * fallback target runs its own configured model, see `modelForTarget`.
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
  attempt: (executor: CallExecutor, onAttempt: () => void, targetIndex: number) => Promise<R>,
  skipBreakerCheckForFirst = false,
): Promise<FallbackChainOutcome<R>> {
  const fallbackAttempts: FallbackAttempt[] = [];

  for (let targetIndex = 0; targetIndex < dependencies.executors.length; targetIndex++) {
    const executor = dependencies.executors[targetIndex]!;
    const targetModel = modelForTarget(params, targetIndex);
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
        const checking = executor.assertBreakerClosed(targetModel, {
          requestId,
          state: middlewareState,
          signal: params.signal,
        });
        // Only a breaker with a `prepare` hands back something to wait for.
        if (checking) await checking;
      }

      const result = await attempt(
        executor,
        () => {
          attemptCount += 1;
        },
        targetIndex,
      );
      return {
        result,
        executor,
        index: targetIndex,
        attemptCount,
        model: targetModel ?? executor.model,
      };
    } catch (error) {
      const normalizedError = normalizeError(error, params.signal);

      // Whatever ended this target, a half-open trial it claimed and never
      // settled must not stay held. Idempotent, so this is also safe when
      // the failure was already recorded against the breaker.
      executor.releaseBreakerTrial(targetModel, {
        requestId,
        state: middlewareState,
        signal: params.signal,
      });

      fallbackAttempts.push({
        index: targetIndex - 1,
        provider: executor.providerName,
        model: targetModel ?? executor.model,
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
      const failedModel = targetModel ?? executor.model;

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
        registeredMiddlewareNames: middlewareLabels(dependencies.middleware),
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

/** The `CallResult.meta` fields for whichever target answered. */
function metaFor(
  executor: CallExecutor,
  index: number,
  attemptCount: number,
  model: string,
): CallMeta {
  return {
    provider: executor.providerName,
    model,
    fallbackIndex: index - 1,
    usedFallback: index > 0,
    attempts: attemptCount,
  };
}

/**
 * Builds the `CallResult.meta` block from a `runFallbackChain` outcome
 * and, when `params.meta` was given, writes it into `meta.current`.
 * Shared by `executeLogicalCall` and `executeLogicalStreamCall`, which
 * differ only in what they pass as `runFallbackChain`'s `attempt`.
 */
function buildCallResult<R>(
  outcome: FallbackChainOutcome<R>,
  params: Pick<CallParams<unknown>, 'meta'>,
): CallResult<R> {
  const meta = metaFor(outcome.executor, outcome.index, outcome.attemptCount, outcome.model);

  // `params` here is the same object `VernLLM.call()` received from the
  // caller, not a clone, so this write is visible on the caller's own
  // `meta` out-parameter too.
  if (params.meta) {
    params.meta.current = meta;
  }

  return { value: outcome.result, meta };
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
    (executor, onAttempt, targetIndex) =>
      executor.run(paramsForTarget(params, targetIndex), requestId, onAttempt, middlewareState),
    soleTarget,
  );

  return buildCallResult(fallbackChainOutcome, params);
}

/**
 * Streaming counterpart to `executeLogicalCall`. Resolves as soon as the
 * first stream opens (a keep-alive ping is enough), so the caller holds
 * `chunks` and `finalResult` while the model is still thinking. Until
 * the first content chunk arrives, the fallback chain keeps running
 * behind them: a failure before content retries and falls back as
 * usual, and the returned `chunks` and `finalResult` follow whichever
 * attempt produces content. `meta` starts out describing the target that
 * opened and is updated in place once the answering target is known.
 *
 * A chain that fails before any stream opens rejects this call, exactly
 * as before.
 */
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
  type Opened = { executor: CallExecutor; index: number; attempts: number };

  let resolveOpened!: (opened: Opened) => void;
  const opened = new Promise<Opened>((resolve) => {
    resolveOpened = resolve;
  });

  const chain = runFallbackChain(
    dependencies,
    params,
    requestId,
    middlewareState,
    (executor, onAttempt, targetIndex) => {
      let attempts = 0;
      return executor.runStream(
        paramsForTarget(params, targetIndex),
        requestId,
        () => {
          attempts += 1;
          onAttempt();
        },
        middlewareState,
        () => resolveOpened({ executor, index: targetIndex, attempts }),
      );
    },
    soleTarget,
  );

  // Handled through `finalResult` and `chunks` once the stream has opened.
  chain.catch(() => {});

  const first = await Promise.race([
    opened.then((value) => ({ kind: 'opened' as const, value })),
    chain.then((value) => ({ kind: 'settled' as const, value })),
  ]);

  if (first.kind === 'settled') return buildCallResult(first.value, params);

  const { executor, index, attempts } = first.value;
  const meta = metaFor(executor, index, attempts, modelForTarget(params, index) ?? executor.model);
  if (params.meta) params.meta.current = meta;

  const finalResult = chain.then((outcome) => {
    // Same object the caller already holds, so a reopened stream shows up in it.
    Object.assign(
      meta,
      metaFor(outcome.executor, outcome.index, outcome.attemptCount, outcome.model),
    );
    return outcome.result.finalResult;
  });

  // Avoid an unhandled rejection for a caller that only reads `chunks`.
  finalResult.catch(() => {});

  const chunks: AsyncIterable<StreamChunk> = {
    async *[Symbol.asyncIterator]() {
      const outcome = await chain;
      yield* outcome.result.chunks;
    },
  };

  return { value: { chunks, finalResult }, meta };
}
