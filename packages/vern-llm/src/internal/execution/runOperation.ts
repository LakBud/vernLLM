import { callScopeFor, noopEmit } from '../utils/callScope.utils.js';
import { logError } from '../utils/logger.utils.js';
import { modelForTarget } from './logicalCall.js';
import { describeTargets, narrowTargets, type ResolvedTarget } from './targetOrder.js';
import {
  emitEvent,
  reclassifyMiddlewareThrow,
  middlewareLabel,
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
} from '../../types/index.js';
import type { MiddlewarePipeline } from '../resolveMiddlewareOrder.js';
import type { CallExecutor } from './callExecutor.js';

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
  coreOperation: (targets: readonly ResolvedTarget[]) => Promise<CallResult>,
  /**
   * True when `cachedCall()` already wraps this call, so `wrap` runs once per logical call. Keyed
   * by the params object, not `requestId`, since concurrent `cachedCall()`s can share one.
   */
  skipWrap = false,
): Promise<CallResult> {
  const { wrapOrder, transformOrder, names, transformNames } = dependencies.pipeline;

  if (wrapOrder.length === 0 || skipWrap) {
    return coreOperation(targets);
  }

  const primary = dependencies.primaryExecutor;
  const { model, request } = primary.previewRequest(params);

  // `position` can reorder `wrapOrder`, so labels come from each entry's `transformOrder` index to
  // match `registeredMiddlewareNames`.
  const transformIndexByEntry = new Map(transformOrder.map((entry, index) => [entry, index]));

  // Each level takes the order left by the levels outside it.
  let next: (current: readonly ResolvedTarget[]) => Promise<CallResult> = coreOperation;

  for (let middlewareIndex = wrapOrder.length - 1; middlewareIndex >= 0; middlewareIndex--) {
    const middleware = wrapOrder[middlewareIndex]!;
    const label = middlewareLabel(middleware, transformIndexByEntry.get(middleware)!);
    const inner = next;

    next = async (current): Promise<CallResult> => {
      const ctx: PreDispatchContext = {
        stage: 'pre-dispatch',
        requestId,
        primaryProvider: primary.providerName,
        primaryAdapter: primary.adapter,
        primaryModel: model,
        targets: describeTargets(current, (index) => modelForTarget(params, index)),
        capabilities: { supportsJsonObjectMode: primary.jsonObjectModeSupported },
        signal: params.signal,
        state,
        own: {},
        emit: noopEmit,
        context: callScopeFor(state)?.context,
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
        return inner(current);
      }

      if (!middleware.wrap) return inner(current);

      // The first `next()` call runs `inner` and reads this synchronously, so a later call's
      // options change nothing, like its result.
      let requested: readonly string[] | undefined;
      const onceNext = createOnceAsync(async () =>
        inner(
          narrowTargets(dependencies.targets, current, requested, (name) =>
            dependencies.logger.warn(
              `[VernLLM:${requestId}] middleware "${label}" asked for target "${name}", which an outer layer removed; ignoring it`,
            ),
          ),
        ),
      );
      const wrapNext = (options?: { targets?: readonly string[] }): Promise<CallResult> => {
        requested = options?.targets;
        return onceNext.call();
      };

      try {
        const result = await middleware.wrap(request, wrapNext, withOwn(ctx, middleware, label));

        if (!onceNext.wasCalled()) {
          emitEvent(
            { kind: 'middleware', requestId, middleware: label, hook: 'wrap_short_circuit' },
            ctx,
            dependencies.reportEvent,
            transformOrder,
            dependencies.middlewareTimeoutMs,
            dependencies.logger,
          );
        }

        return result;
      } catch (error) {
        const resolvedResult = onceNext.resolvedValue();

        if (resolvedResult !== undefined) {
          // Rule 3: thrown strictly after next() already resolved
          // successfully. A bug in post-processing can never turn a
          // successful, already-billed call into a false failure.
          logError(
            dependencies.logger,
            `[VernLLM] middleware "${label}".wrap threw after next() resolved; keeping the original result`,
            error,
          );
          return resolvedResult;
        }

        // Rules 1/2: thrown before next() was called, or before it
        // resolved. Passed through normalizeError first so a
        // recognizable status/network error, or an already-built
        // LLMError, keeps its own classification.
        throw reclassifyMiddlewareThrow(error, label, ctx.signal);
      }
    };
  }

  return next(targets);
}
