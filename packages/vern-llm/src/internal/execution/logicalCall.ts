import { LLMError } from '../../types/errors.js';
import { FallbackExhaustedError } from '../../types/fallback.js';
import { callScopeFor, noopEmit } from '../utils/callScope.utils.js';
import { createDeferred } from '../utils/deferred.utils.js';
import { middlewareContextNames } from '../utils/middlewareLabels.utils.js';
import { describeTargets, type ResolvedTarget } from './targetOrder.js';
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
  TargetInfo,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../types/index.js';
import type { CallExecutor } from './callExecutor.js';

/** What the logical call functions need from `VernLLM`, so they can live outside the class. */
export interface LogicalCallDependencies {
  /**
   * The targets this call may try, in the order to try them. Every target as declared, unless the
   * call's `targets` or a `wrap` narrowed or reordered it. Set per call.
   */
  targets: readonly ResolvedTarget[];
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
 * The chain's outcome: the winning result, which target answered, its declared index and its
 * position in the order tried, and how many attempts that target made.
 */
export interface FallbackChainOutcome<TResult> {
  result: TResult;
  executor: CallExecutor;
  /** Declared index, see `ResolvedTarget`. */
  index: number;
  /** Position in the order tried, 0 based. */
  position: number;
  attemptCount: number;
  /** The model the winning target actually ran, see `modelForTarget`. */
  model: string;
}

/**
 * The per call `model` override for this target, or `undefined` to use its own. The override names
 * a model on the primary's provider, so a fallback on another provider can only fail with it.
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
 * Tries each of `dependencies.targets` in order until one succeeds. `skipBreakerCheckForFirst` is
 * set when `call()` already checked the sole target, since checking again would see its own
 * claimed trial. Throws the lone failure when one target was tried, else `FallbackExhaustedError`
 * with every attempt. Events and attempts keep declared indices, whatever the order.
 */
export async function runFallbackChain<R>(
  dependencies: LogicalCallDependencies,
  params: Pick<CallParams<unknown>, 'model' | 'signal'>,
  requestId: string,
  middlewareState: MiddlewareStateBag,
  attempt: (
    executor: CallExecutor,
    onAttempt: () => void,
    targetIndex: number,
    position: number,
  ) => Promise<R>,
  skipBreakerCheckForFirst = false,
): Promise<FallbackChainOutcome<R>> {
  const fallbackAttempts: FallbackAttempt[] = [];

  const { targets } = dependencies;

  for (let position = 0; position < targets.length; position++) {
    const { executor, index: targetIndex } = targets[position]!;
    const targetModel = modelForTarget(params, targetIndex);
    const startedAt = Date.now();
    let attemptCount = 0;

    try {
      // Claiming a half-open trial is a side effect, so a target already checked by `call()` isn't
      // checked twice.
      if (!(position === 0 && skipBreakerCheckForFirst)) {
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
        position,
      );
      return {
        result,
        executor,
        index: targetIndex,
        position,
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

      const isLastTarget = position === targets.length - 1;
      // Always consult fallbackOn, including on the last target, so it
      // sees every failure and callers who log or count from inside it
      // get a complete picture. The chain still stops once the last
      // target fails regardless of what fallbackOn returns: there is
      // no next executor to fall over to.
      const [failed, next] = describeTargets(targets.slice(position, position + 2), (index) =>
        modelForTarget(params, index),
      ) as [TargetInfo, TargetInfo | undefined];
      const policyDecision = dependencies.fallbackOn(normalizedError, {
        isLastTarget,
        failed,
        ...(next ? { next } : {}),
      });
      const decision = isLastTarget ? 'stop' : policyDecision;

      if (decision === 'stop') {
        // A lone target (or a chain that stopped on its first failure)
        // throws its own error, unchanged from pre-fallback behavior.
        throw fallbackAttempts.length > 1
          ? new FallbackExhaustedError(fallbackAttempts)
          : normalizedError;
      }

      reportFallback(dependencies, {
        requestId,
        failed: targets[position]!,
        next: targets[position + 1]!,
        failedModel: targetModel ?? executor.model,
        attempt: attemptCount,
        error: normalizedError,
        elapsedMs: Date.now() - startedAt,
        signal: params.signal,
        middlewareState,
      });
    }
  }

  // Unreachable: the loop above always either returns or throws before
  // running out of targets (the last iteration's `isLastTarget` forces
  // a throw). Kept only to satisfy the return type.
  throw new LLMError('No provider targets configured', 'invalid_params');
}

/**
 * Emits the `'fallback'` event for the `failed` target, moving on to `next`. The context describes
 * the failed target, not the next one. Indices are the declared ones.
 */
function reportFallback(
  dependencies: LogicalCallDependencies,
  failure: {
    requestId: string;
    failed: ResolvedTarget;
    next: ResolvedTarget;
    failedModel: string;
    attempt: number;
    error: LLMError;
    elapsedMs: number;
    signal: AbortSignal | undefined;
    middlewareState: MiddlewareStateBag;
  },
): void {
  const { requestId, signal } = failure;
  const { executor, index: targetIndex } = failure.failed;
  const nextExecutor = failure.next.executor;

  const ctx: AttemptContext = {
    stage: 'attempt',
    requestId,
    requestedProvider: executor.providerName,
    adapter: executor.adapter,
    requestedModel: failure.failedModel,
    isFallbackAttempt: targetIndex > 0,
    // Stays 0 when the breaker check threw before any attempt; the field is 1-based.
    attempt: failure.attempt || 1,
    capabilities: { supportsJsonObjectMode: executor.jsonObjectModeSupported },
    signal,
    state: failure.middlewareState,
    own: {},
    emit: noopEmit,
    context: callScopeFor(failure.middlewareState)?.context,
    ...middlewareContextNames(dependencies.middleware),
  };

  emitEvent(
    {
      kind: 'fallback',
      requestId,
      from: executor.providerName,
      to: nextExecutor.providerName,
      fromIndex: targetIndex - 1,
      toIndex: failure.next.index - 1,
      error: failure.error,
      elapsedMs: failure.elapsedMs,
    },
    ctx,
    dependencies.reportEvent,
    dependencies.middleware,
    dependencies.middlewareTimeoutMs,
    dependencies.logger,
  );
}

/** The `CallResult.meta` fields for whichever target answered. */
function metaFor(
  executor: CallExecutor,
  index: number,
  position: number,
  attemptCount: number,
  model: string,
): CallMeta {
  return {
    provider: executor.providerName,
    model,
    // Declared, so they keep meaning "a declared fallback answered" in any order.
    fallbackIndex: index - 1,
    usedFallback: index > 0,
    attempts: attemptCount,
    position,
  };
}

/**
 * Builds `CallResult.meta` from the chain's outcome and writes it to `params.meta.current` when
 * given.
 */
function buildCallResult<R>(
  outcome: FallbackChainOutcome<R>,
  params: Pick<CallParams<unknown>, 'meta'>,
): CallResult<R> {
  const meta = metaFor(
    outcome.executor,
    outcome.index,
    outcome.position,
    outcome.attemptCount,
    outcome.model,
  );

  // `params` here is the same object `VernLLM.call()` received from the
  // caller, not a clone, so this write is visible on the caller's own
  // `meta` out-parameter too.
  if (params.meta) {
    params.meta.current = meta;
  }

  return { value: outcome.result, meta };
}

/**
 * The fallback chain and retries of one non-streaming call, without `wrap`. Each caller wraps it
 * once, so no value passes through `wrap` twice.
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
 * Streaming counterpart to `executeLogicalCall`. Resolves when the first stream opens, a ping
 * included, while the chain keeps running behind it until content arrives: a failure before content
 * still retries and falls back, and `chunks` and `finalResult` follow whichever attempt answers.
 * `meta` is updated in place once that target is known.
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
  type Opened = { executor: CallExecutor; index: number; position: number; attempts: number };

  const { promise: opened, resolve: resolveOpened } = createDeferred<Opened>();

  const chain = runFallbackChain(
    dependencies,
    params,
    requestId,
    middlewareState,
    (executor, onAttempt, targetIndex, position) => {
      let attempts = 0;
      return executor.runStream(
        paramsForTarget(params, targetIndex),
        requestId,
        () => {
          attempts += 1;
          onAttempt();
        },
        middlewareState,
        () => resolveOpened({ executor, index: targetIndex, position, attempts }),
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

  const { executor, index, position, attempts } = first.value;
  const meta = metaFor(
    executor,
    index,
    position,
    attempts,
    modelForTarget(params, index) ?? executor.model,
  );
  if (params.meta) params.meta.current = meta;

  const finalResult = chain.then((outcome) => {
    // Same object the caller already holds, so a reopened stream shows up in it.
    Object.assign(
      meta,
      metaFor(
        outcome.executor,
        outcome.index,
        outcome.position,
        outcome.attemptCount,
        outcome.model,
      ),
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
