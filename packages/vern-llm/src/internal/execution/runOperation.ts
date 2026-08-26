import {
  reclassifyMiddlewareThrow,
  middlewareLabel,
  reportMiddlewareEvent,
  resolveEnabled,
} from './utils/middleware.utils.js';

import type { Logger } from '../../logger.js';
import type {
  CallParams,
  CallResult,
  MiddlewareContext,
  MiddlewareStateBag,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../types/index.js';
import type { CallExecutor } from './callExecutor.js';

/**
 * Everything `runOperation` needs from `VernLLM` itself, gathered into
 * one small object so it can live outside the class as a plain,
 * independently testable function instead of a private method.
 */
export interface RunOperationDependencies {
  /** See `VernLLMOptions.middleware`. Already sorted by `priority`, ascending, ties broken by original array order. */
  middleware: VernLLMMiddleware[];
  /** The primary target, used to build the `previewRequest` handed to every `wrap` (and the `requestedProvider`/`requestedModel` every middleware's `ctx` carries). */
  primaryExecutor: CallExecutor;
  /** See `VernLLMOptions.middlewareTimeoutMs`. Bounds `transform` and a function `enabled`; `wrap` itself is never bounded by this. */
  middlewareTimeoutMs: number;
  logger: Logger;
  /** Reports the `'middleware'` trace event for an `enabled_skip` or `wrap_short_circuit`. */
  reportEvent: (event: VernLLMEvent) => void;
}

/**
 * Wraps `coreOperation` (one whole logical call, retries and fallback
 * targets included) in every applicable middleware's `wrap`, composed
 * like nested function calls: lower `priority` is outermost, starts
 * first, finishes last. `previewRequest` is built from the primary
 * target only (before any target is actually chosen), matching
 * `MiddlewareContext`'s own documented caveat for `wrap`.
 *
 * Each middleware's `next()` resolves to `coreOperation`'s own result
 * once every inner middleware (and the real call) has run, or to
 * whatever an inner middleware short-circuited with instead. A `wrap`
 * that never calls `next()` skips `coreOperation`, and everything nested
 * inside it, entirely.
 */
export async function runOperation(
  dependencies: RunOperationDependencies,
  params: CallParams<unknown>,
  requestId: string,
  state: MiddlewareStateBag,
  coreOperation: () => Promise<CallResult>,
  /**
   * `true` when `VernLLM.cachedCall()` is already wrapping this exact
   * invocation's `params` object in its own outer `runOperation` call,
   * around the whole cache hit/miss/join operation. Skips wrapping
   * again here so one logical `cachedCall()` still only ever runs
   * `wrap` once: without it, a cache miss (which internally calls
   * `VernLLM.call()` to get the same retry/timeout/breaker guarantees
   * as a direct call) would run every `wrap` middleware twice for the
   * one logical operation the caller made.
   *
   * Computed by the caller from a marker scoped to this one `params`
   * object (see `VernLLM`'s own `cachedCallInnerParams`), not from
   * `requestId`: two concurrent `cachedCall()` invocations can share
   * the same caller-supplied explicit `requestId`, and a `Set<string>`
   * keyed by that id would let one invocation's inner-call marker
   * suppress the *other* invocation's own outer `wrap`.
   */
  skipWrap = false,
): Promise<CallResult> {
  if (dependencies.middleware.length === 0 || skipWrap) {
    return coreOperation();
  }

  const primary = dependencies.primaryExecutor;
  const { model, request } = primary.previewRequest(params);

  let next: () => Promise<CallResult> = coreOperation;

  for (
    let middlewareIndex = dependencies.middleware.length - 1;
    middlewareIndex >= 0;
    middlewareIndex--
  ) {
    const middleware = dependencies.middleware[middlewareIndex]!;
    const label = middlewareLabel(middleware, middlewareIndex);
    const inner = next;

    next = async (): Promise<CallResult> => {
      const ctx: MiddlewareContext = {
        requestId,
        requestedProvider: primary.providerName,
        requestedModel: model,
        isFallbackAttempt: false,
        attempt: 1,
        capabilities: { supportsJsonObjectMode: primary.jsonObjectModeSupported },
        signal: params.signal,
        state,
        own: {},
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
          reportMiddlewareEvent(dependencies.reportEvent, {
            kind: 'middleware',
            requestId,
            middleware: label,
            hook: 'enabled_skip',
          });
        }
        return inner();
      }

      if (!middleware.wrap) return inner();

      let calledNext = false;
      let resolvedResult: CallResult | undefined;

      const nextFn = async (): Promise<CallResult> => {
        calledNext = true;
        const result = await inner();
        resolvedResult = result;
        return result;
      };

      try {
        const result = await middleware.wrap(request, nextFn, ctx);

        if (!calledNext) {
          reportMiddlewareEvent(dependencies.reportEvent, {
            kind: 'middleware',
            requestId,
            middleware: label,
            hook: 'wrap_short_circuit',
          });
        }

        return result;
      } catch (error) {
        if (resolvedResult !== undefined) {
          // Rule 3: thrown strictly after next() already resolved
          // successfully. A bug in post-processing can never turn a
          // successful, already-billed call into a false failure.
          dependencies.logger.error(
            `[VernLLM] middleware "${label}".wrap threw after next() resolved; keeping the original result`,
            { message: error instanceof Error ? error.message : 'unknown' },
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

  return next();
}
