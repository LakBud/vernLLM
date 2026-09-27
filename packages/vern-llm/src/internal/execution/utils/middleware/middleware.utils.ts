import {
  LLMError,
  type AttemptContext,
  type MiddlewareContext,
  type MiddlewareStateBag,
  type VernLLMEvent,
  type VernLLMMiddleware,
  type WireCallRequest,
  type WireCallRequestPatch,
} from '../../../../types/index.js';
import { logError, logHookError } from '../../../utils/logger.utils.js';
import { middlewareLabel } from '../../../utils/middlewareLabels.utils.js';
import { normalizeError } from '../errors.utils.js';
import { createOnceAsync } from '../once.utils.js';
import {
  assertModelAndResponseFormatUnchanged,
  assertNoDuplicateTools,
  mergePatch,
} from './transformPatch.utils.js';

import type { Logger } from '../../../../logger.js';

/** Default `middlewareTimeoutMs`, used both as `VernLLMOptions`'s own default and as the instance-level bound `CallExecutor` falls back to when none is passed in. Bounds `transform` and a function `enabled`; `wrap` itself is never bounded by this. */
export const DEFAULT_MIDDLEWARE_TIMEOUT_MS = 5000;

export {
  assertModelAndResponseFormatUnchanged,
  assertNoDuplicateTools,
  mergePatch,
} from './transformPatch.utils.js';

/** `middleware.name`, or its array position if unnamed. Used in log lines and the `'middleware'` event. */
export { middlewareLabel };

/** Each middleware's `ctx.own`, per logical call (keyed by that call's state bag). */
const ownStores = new WeakMap<
  MiddlewareStateBag,
  Map<VernLLMMiddleware, Record<string, unknown>>
>();

/**
 * `ctx` with `own` set to this middleware's scratch object for the call. The same object is
 * returned for every hook, so a value set in `wrap` is there in `transform`. Collected with the
 * call's state bag.
 */
export function withOwn<C extends MiddlewareContext>(ctx: C, entry: VernLLMMiddleware): C {
  let store = ownStores.get(ctx.state);

  if (!store) {
    store = new Map();
    ownStores.set(ctx.state, store);
  }

  let own = store.get(entry);

  if (!own) {
    own = {};
    store.set(entry, own);
  }

  return { ...ctx, own };
}

/**
 * Bounds `transform` and a function `enabled`, which take no signal, with a plain race. A hung
 * middleware keeps running but is no longer awaited. The rejection names `label` and uses code
 * `middleware_timeout`, which is never retried. `timeoutMs <= 0` means unbounded.
 */
function raceTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return fn();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new LLMError(`middleware "${label}" timed out after ${timeoutMs}ms`, 'timeout', {
          code: 'middleware_timeout',
        }),
      );
    }, timeoutMs);

    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Resolves `enabled` for one call. A throwing or timed out predicate is logged and treated as
 * `false`.
 */
export async function resolveEnabled(
  middleware: VernLLMMiddleware,
  ctx: MiddlewareContext,
  label: string,
  middlewareTimeoutMs: number,
  logger: Logger,
): Promise<boolean> {
  const { enabled } = middleware;

  if (enabled === undefined) return true;
  if (typeof enabled === 'boolean') return enabled;

  const timeoutMs = middleware.timeoutMs ?? middlewareTimeoutMs;

  try {
    return await raceTimeout(async () => enabled(withOwn(ctx, middleware)), timeoutMs, label);
  } catch (error) {
    logError(
      logger,
      `[VernLLM] middleware "${label}".enabled threw or timed out, treating as disabled`,
      error,
    );
    return false;
  }
}

/** Everything `applyMiddlewareTransforms` needs beyond the request itself. */
export interface ApplyMiddlewareTransformsParams {
  request: WireCallRequest;
  requestId: string;
  attempt: number;
  signal: AbortSignal | undefined;
  state: MiddlewareStateBag;
  /** Already in `transform`/`onEvent` order. Order is decided once, at `VernLLM` construction time, by `buildMiddlewarePipeline`/`resolveMiddlewareOrder` (`resolveMiddlewareOrder.ts`); this function trusts the order it's handed and never re-sorts it. */
  middleware: VernLLMMiddleware[];
  middlewareTimeoutMs: number;
  logger: Logger;
  reportEvent: (event: VernLLMEvent) => void;
  buildContext: (
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ) => AttemptContext;
  /**
   * Filled with every entry whose `enabled` resolved true for this
   * attempt, so `dispatch` reuses the same decision instead of asking a
   * predicate twice and possibly getting a different answer.
   */
  enabledEntries?: Set<VernLLMMiddleware>;
}

/**
 * Runs each applicable `transform` in order, merging each patch at once so later ones see it.
 * Reports a `'middleware'` event for each change and each skip.
 */
export async function applyMiddlewareTransforms(
  params: ApplyMiddlewareTransformsParams,
): Promise<WireCallRequest> {
  const {
    request,
    requestId,
    attempt,
    signal,
    state,
    middleware,
    middlewareTimeoutMs,
    logger,
    reportEvent,
    buildContext,
    enabledEntries,
  } = params;

  if (middleware.length === 0) return request;

  const before = request;
  let current = request;

  for (const [index, middlewareEntry] of middleware.entries()) {
    const label = middlewareLabel(middlewareEntry, index);

    const ctx = buildContext(attempt, signal, state);

    const isEnabled = await resolveEnabled(
      middlewareEntry,
      ctx,
      label,
      middlewareTimeoutMs,
      logger,
    );

    if (!isEnabled) {
      if (middlewareEntry.enabled !== undefined) {
        emitEvent(
          { kind: 'middleware', requestId, middleware: label, hook: 'enabled_skip' },
          ctx,
          reportEvent,
          middleware,
          middlewareTimeoutMs,
          logger,
        );
      }
      continue;
    }

    enabledEntries?.add(middlewareEntry);

    if (!middlewareEntry.transform) continue;

    const patch = await runTransform(
      middlewareEntry,
      structuredClone(current),
      ctx,
      label,
      middlewareTimeoutMs,
    );
    const { request: merged, patchedFields } = mergePatch(current, patch);

    if (patchedFields.length > 0) {
      if (patch.tools !== undefined || patch.addTools?.length) {
        assertNoDuplicateTools(merged, label);
      }
      emitEvent(
        { kind: 'middleware', requestId, middleware: label, hook: 'transform', patchedFields },
        ctx,
        reportEvent,
        middleware,
        middlewareTimeoutMs,
        logger,
      );
    }

    current = merged;
  }

  assertModelAndResponseFormatUnchanged(before, current, 'chain');

  return current;
}

/**
 * Runs one `transform` within its timeout. A throw is normalized, and only an unrecognizable one
 * becomes `invalid_params` naming the middleware.
 */
export async function runTransform(
  middleware: VernLLMMiddleware,
  request: Readonly<WireCallRequest>,
  ctx: AttemptContext,
  label: string,
  middlewareTimeoutMs: number,
): Promise<WireCallRequestPatch> {
  if (!middleware.transform) return {};

  const timeoutMs = middleware.timeoutMs ?? middlewareTimeoutMs;

  try {
    return await raceTimeout(
      async () => middleware.transform!(request, withOwn(ctx, middleware)),
      timeoutMs,
      label,
    );
  } catch (error) {
    throw reclassifyMiddlewareThrow(error, label, ctx.signal);
  }
}

/** One `dispatch` hook to run, with the label logs and errors use for it. */
export interface DispatchHook {
  entry: VernLLMMiddleware & { dispatch: NonNullable<VernLLMMiddleware['dispatch']> };
  label: string;
}

/** Everything `runDispatch` needs. */
export interface RunDispatchParams {
  /** The final request, after every `transform`. Each hook gets its own copy. */
  request: WireCallRequest;
  /** Outermost first. Already filtered to entries enabled for this attempt. */
  hooks: readonly DispatchHook[];
  ctx: AttemptContext;
  /** Sends the provider request. Rejects with an `LLMError`. */
  send: () => Promise<void>;
  logger: Logger;
}

/**
 * Runs `send` inside every `dispatch` hook, outermost first, settling with `send`'s outcome. Once
 * `next()` was called a hook throw is only logged; a hook that never called it fails the attempt.
 */
export async function runDispatch(params: RunDispatchParams): Promise<void> {
  const { request, hooks, ctx, send, logger } = params;

  if (hooks.length === 0) return send();

  const provider = createOnceAsync(send);

  const runLayer = async (index: number): Promise<void> => {
    if (index === hooks.length) return provider.call();

    const { entry, label } = hooks[index]!;
    const inner = createOnceAsync(() => runLayer(index + 1));
    let hookFailure: { error: unknown } | undefined;

    try {
      await entry.dispatch(structuredClone(request), inner.call, withOwn(ctx, entry));
    } catch (error) {
      hookFailure = { error };
    }

    if (!inner.wasCalled()) {
      if (hookFailure) throw reclassifyMiddlewareThrow(hookFailure.error, label, ctx.signal);

      throw new LLMError(
        `middleware "${label}".dispatch returned without calling next(), so no request was sent`,
        'invalid_params',
        { code: 'middleware_threw' },
      );
    }

    try {
      await inner.call();
    } catch (error) {
      // A hook rethrowing the provider's own error is the normal path, not a hook bug.
      if (hookFailure && hookFailure.error !== error) {
        logHookError(logger, `middleware "${label}".dispatch`, hookFailure.error);
      }
      throw error;
    }

    if (hookFailure) logHookError(logger, `middleware "${label}".dispatch`, hookFailure.error);
  };

  return runLayer(0);
}

/**
 * A middleware throw keeps any classification `normalizeError` recognizes. Only an unrecognizable
 * one becomes `invalid_params`.
 */
export function reclassifyMiddlewareThrow(
  error: unknown,
  label: string,
  signal?: AbortSignal,
): LLMError {
  const normalized = normalizeError(error, signal);

  if (normalized.type !== 'unknown') {
    return normalized;
  }

  return new LLMError(`middleware "${label}" threw: ${normalized.message}`, 'invalid_params', {
    code: 'middleware_threw',
    cause: error,
  });
}

/**
 * Reports `event` through the instance-level reporter, then fans it out to every applicable
 * middleware's own `onEvent`. Never throws or rejects.
 *
 * Handlers of entries with a static (or absent) `enabled` run synchronously, in registration
 * order, before this returns. Emit sites sit on the call path, so a token attribute or a span
 * ended off a `usage` event is visible before the code after `next()` resumes.
 */
export function emitEvent(
  event: VernLLMEvent,
  ctx: MiddlewareContext,
  reportEventInstance: (event: VernLLMEvent) => void,
  middleware: VernLLMMiddleware[],
  middlewareTimeoutMs: number,
  logger: Logger,
): void {
  reportEventInstance(event);

  if (middleware.length === 0) return;

  dispatchEventToMiddleware(middleware, event, ctx, middlewareTimeoutMs, logger);
}

/** Calls `onEvent`, logging a sync throw or a rejection instead of propagating either. */
function invokeOnEvent(
  entry: VernLLMMiddleware,
  label: string,
  event: VernLLMEvent,
  ctx: MiddlewareContext,
  logger: Logger,
): void {
  try {
    void Promise.resolve(entry.onEvent!(event, withOwn(ctx, entry))).catch((error: unknown) => {
      logHookError(logger, `middleware "${label}".onEvent`, error);
    });
  } catch (error) {
    logHookError(logger, `middleware "${label}".onEvent`, error);
  }
}

/**
 * Calls `onEvent` on every enabled middleware. A function `enabled` resolves per entry, so it never
 * holds back the others.
 */
function dispatchEventToMiddleware(
  middleware: VernLLMMiddleware[],
  event: VernLLMEvent,
  ctx: MiddlewareContext,
  middlewareTimeoutMs: number,
  logger: Logger,
): void {
  for (let index = 0; index < middleware.length; index++) {
    const entry = middleware[index]!;
    if (!entry.onEvent) continue;

    const label = middlewareLabel(entry, index);
    const { enabled } = entry;

    if (enabled === undefined || enabled === true) {
      invokeOnEvent(entry, label, event, ctx, logger);
    } else if (enabled === false) {
      continue;
    } else {
      void resolveEnabled(entry, ctx, label, middlewareTimeoutMs, logger).then((isEnabled) => {
        if (isEnabled) invokeOnEvent(entry, label, event, ctx, logger);
      });
    }
  }
}

/**
 * Every entry with a `dispatch`, in `order` (outermost first), labeled by its
 * `transformOrder` position so an unnamed entry reads the same as in
 * `registeredMiddlewareNames` whatever `position` it pins.
 */
export function buildDispatchHooks(
  transformOrder: VernLLMMiddleware[],
  order: VernLLMMiddleware[] = transformOrder,
): readonly DispatchHook[] {
  const indexByEntry = new Map(transformOrder.map((entry, index) => [entry, index]));

  return order.flatMap((entry) =>
    entry.dispatch
      ? [
          {
            entry: entry as DispatchHook['entry'],
            label: middlewareLabel(entry, indexByEntry.get(entry)!),
          },
        ]
      : [],
  );
}
