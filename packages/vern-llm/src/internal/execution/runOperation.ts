import { isLLMError } from '../../types/errors.js';
import { callFactsFor, callScopeFor, noopEmit } from '../utils/callScope.utils.js';
import { logError } from '../utils/logger.utils.js';
import { modelForTarget } from './logicalCall.js';
import { describeTargets, narrowTargets, type ResolvedTarget } from './targetOrder.js';
import { ChainSet, type Chain } from './utils/middleware/chains.utils.js';
import {
  emitEvent,
  reclassifyMiddlewareThrow,
  middlewareLabel,
  recordWrapLayers,
  resolveEnabled,
  withOwn,
} from './utils/middleware/middleware.utils.js';
import { createOnceAsync } from './utils/once.utils.js';

import type { Logger } from '../../logger.js';
import type {
  CallParams,
  CallResult,
  MiddlewareStateBag,
  PreDispatchContext,
  VernLLMEvent,
  VernLLMMiddleware,
  WrapNext,
  WrapNextOptions,
} from '../../types/index.js';
import type { MiddlewarePipeline } from '../resolveMiddlewareOrder.js';
import type { CallExecutor } from './callExecutor.js';

/** Entries already warned about a returned value no chain produced, so each warns once. */
const warnedNoChainKept = new WeakSet<VernLLMMiddleware>();

/**
 * Everything `runOperation` needs from `VernLLM` itself, gathered into
 * one small object so it can live outside the class as a plain,
 * independently testable function instead of a private method.
 */
export interface RunOperationDependencies {
  /**
   * Middleware order, built once at construction. `wrap` nests by `wrapOrder`; labels and events
   * use `transformOrder`.
   */
  pipeline: MiddlewarePipeline;
  /** The primary target, used to build the `previewRequest` handed to every `wrap` (and the `primaryProvider`/`primaryModel` its `ctx` carries). */
  primaryExecutor: CallExecutor;
  /** Every configured target in declared order, the pool a `wrap`'s `next({ targets })` picks from. */
  targets: readonly ResolvedTarget[];
  /** See `VernLLMOptions.middlewareTimeoutMs`. Bounds `transform` and a function `enabled`; `wrap` itself is never bounded by this. */
  middlewareTimeoutMs: number;
  logger: Logger;
  /** Reports the `'middleware'` trace event for an `enabled_skip` or `wrap_short_circuit`. */
  reportEvent: (event: VernLLMEvent) => void;
}

/**
 * Ends a `reruns` layer: cancels every chain but the one `result` came from, and returns its
 * number. The main chain wrote the caller's `meta` itself; a kept rerun's is written here.
 */
function settleChains(chains: ChainSet, result: CallResult, chain: Chain): number | undefined {
  const kept = chains.keep(result);

  if (kept !== undefined && kept !== chain.number && chain.params.meta) {
    chain.params.meta.current = result.meta;
  }

  return kept;
}

function warnNoChainKept(logger: Logger, middleware: VernLLMMiddleware, label: string): void {
  if (warnedNoChainKept.has(middleware)) return;

  warnedNoChainKept.add(middleware);
  logger.warn(
    `[VernLLM] middleware "${label}" returned a value no chain produced; every chain was cancelled`,
  );
}

/** One layer of the nesting: the order it may use, and the chain it runs in. */
type Inner = (targets: readonly ResolvedTarget[], chain: Chain) => Promise<CallResult>;

/**
 * Wraps one whole logical call in every applicable `wrap`, lower priority outermost. `ctx` is a
 * `PreDispatchContext` with a preview request from the primary, since no attempt has started yet.
 * A `wrap` that never calls `next()` skips everything inside it.
 *
 * `targets` is the order the call starts with. Each `wrap` sees it as `ctx.targets` and may
 * reorder or drop through `next({ targets })`, never widen it, and `coreOperation` runs the order
 * that is left.
 */
export async function runOperation(
  dependencies: RunOperationDependencies,
  params: CallParams<unknown>,
  requestId: string,
  state: MiddlewareStateBag,
  targets: readonly ResolvedTarget[],
  coreOperation: (targets: readonly ResolvedTarget[], chain: Chain) => Promise<CallResult>,
  /**
   * True when `cachedCall()` already wraps this call, so `wrap` runs once per logical call. Keyed
   * by the params object, not `requestId`, since concurrent `cachedCall()`s can share one.
   */
  skipWrap = false,
): Promise<CallResult> {
  const { wrapOrder, transformOrder, names, transformNames } = dependencies.pipeline;
  const main: Chain = { number: 0, params };

  if (wrapOrder.length === 0 || skipWrap) {
    return coreOperation(targets, main);
  }

  const primary = dependencies.primaryExecutor;
  const { model, request } = primary.previewRequest(params);

  // `position` can reorder `wrapOrder`, so labels come from each entry's `transformOrder` index to
  // match `registeredMiddlewareNames`.
  const transformIndexByEntry = new Map(transformOrder.map((entry, index) => [entry, index]));

  recordWrapLayers(state, new Map(wrapOrder.map((entry, index) => [entry, index])));

  // Reruns started so far, shared by every layer of the call.
  const reruns = { count: 0 };

  // Each level takes the order left by the levels outside it, and the chain it runs in.
  let next: Inner = coreOperation;

  for (let middlewareIndex = wrapOrder.length - 1; middlewareIndex >= 0; middlewareIndex--) {
    const middleware = wrapOrder[middlewareIndex]!;
    const label = middlewareLabel(middleware, transformIndexByEntry.get(middleware)!);
    const inner = next;

    next = async (current, chain): Promise<CallResult> => {
      const ctx: PreDispatchContext = {
        stage: 'pre-dispatch',
        requestId,
        primaryProvider: primary.providerName,
        primaryAdapter: primary.adapter,
        primaryModel: model,
        targets: describeTargets(current, (index) => modelForTarget(params, index)),
        capabilities: { supportsJsonObjectMode: primary.jsonObjectModeSupported },
        signal: chain.params.signal,
        ...(chain.number > 0 ? { chain: chain.number } : {}),
        state,
        own: {},
        emit: noopEmit,
        context: callScopeFor(state)?.context,
        ...callFactsFor(state),
        registeredMiddlewareNames: names,
        transformMiddlewareNames: transformNames,
      };

      const isEnabled = await resolveEnabled(
        middleware,
        ctx,
        label,
        dependencies.middlewareTimeoutMs,
        dependencies.logger,
      );

      if (!isEnabled) {
        if (middleware.enabled !== undefined) {
          emitEvent(
            { kind: 'middleware', requestId, middleware: label, hook: 'enabled_skip' },
            ctx,
            dependencies.reportEvent,
            transformOrder,
            dependencies.middlewareTimeoutMs,
            dependencies.logger,
          );
        }
        return inner(current, chain);
      }

      if (!middleware.wrap) return inner(current, chain);

      // Only an entry with `reruns` gets chains of its own; every other entry passes the incoming
      // chain straight through, so it runs exactly as it always did.
      const chains =
        middleware.reruns === true
          ? new ChainSet(chain, reruns, middlewareIndex, state)
          : undefined;

      // Narrowed against what this layer may use, for `next()` and `next.again()` alike.
      const narrow = (requestedTargets: readonly string[] | undefined) =>
        narrowTargets(dependencies.targets, current, requestedTargets, (name) =>
          dependencies.logger.warn(
            `[VernLLM:${requestId}] middleware "${label}" asked for target "${name}", which an outer layer removed; ignoring it`,
          ),
        );

      // The first `next()` call runs `inner` and reads this synchronously, so a later call's
      // options change nothing, like its result.
      let requested: readonly string[] | undefined;
      const onceNext = createOnceAsync(async () => {
        const targetsLeft = narrow(requested);

        return chains
          ? chains.main((mainChain) => inner(targetsLeft, mainChain))
          : inner(targetsLeft, chain);
      });
      const wrapNext = ((options?: WrapNextOptions): Promise<CallResult> => {
        requested = options?.targets;
        return onceNext.call();
      }) as WrapNext;

      if (chains) {
        const again = (options?: WrapNextOptions): Promise<CallResult> => {
          // Validated before a chain starts, so a bad `targets` rejects like next()'s does and
          // doesn't use up one of the call's reruns.
          let targetsLeft: ResolvedTarget[];

          try {
            targetsLeft = narrow(options?.targets);
          } catch (error) {
            return Promise.reject(error);
          }

          return chains.rerun((rerunChain) => inner(targetsLeft, rerunChain));
        };

        // A getter, so `next.again` reads undefined once the call has used its reruns.
        Object.defineProperty(wrapNext, 'again', {
          get: () => (chains.canRerun ? again : undefined),
        });
      }

      try {
        const result = await middleware.wrap(request, wrapNext, withOwn(ctx, middleware, label));

        if (!onceNext.wasCalled() && !chains?.startedAny) {
          emitEvent(
            { kind: 'middleware', requestId, middleware: label, hook: 'wrap_short_circuit' },
            ctx,
            dependencies.reportEvent,
            transformOrder,
            dependencies.middlewareTimeoutMs,
            dependencies.logger,
          );
        }

        if (chains) {
          const kept = settleChains(chains, result, chain);

          if (kept === undefined && chains.firstResolved() !== undefined) {
            warnNoChainKept(dependencies.logger, middleware, label);
          }
        }

        return result;
      } catch (error) {
        const resolvedResult = chains ? chains.firstResolved() : onceNext.resolvedValue();

        if (resolvedResult !== undefined) {
          // A deliberate refusal of the result, not a bug in post-processing: pass it through.
          if (isLLMError(error) && error.code === 'content_blocked') {
            chains?.keep(undefined);
            throw error;
          }

          // Rule 3: thrown strictly after next() already resolved
          // successfully. A bug in post-processing can never turn a
          // successful, already-billed call into a false failure.
          logError(
            dependencies.logger,
            `[VernLLM] middleware "${label}".wrap threw after next() resolved; keeping the original result`,
            error,
          );
          if (chains) settleChains(chains, resolvedResult, chain);
          return resolvedResult;
        }

        // Rules 1/2: thrown before next() was called, or before it
        // resolved. Passed through normalizeError first so a
        // recognizable status/network error, or an already-built
        // LLMError, keeps its own classification. A chain still running is cancelled.
        chains?.keep(undefined);
        throw reclassifyMiddlewareThrow(error, label, ctx.signal);
      }
    };
  }

  return next(targets, main);
}
