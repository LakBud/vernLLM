import {
  CircuitBreaker,
  type CircuitBreakerAdapter,
  type CircuitBreakerOptions,
  type CircuitBreakerStateChangeHandler,
} from '../../../circuitBreaker.js';
import { LLMError } from '../../../types/errors.js';
import { createMiddlewareStateBag } from '../../../types/middleware.js';
import { emitEvent } from '../../execution/utils/middleware/middleware.utils.js';
import { CUSTOM_ADAPTER } from '../adapterInfo.utils.js';
import { middlewareContextNames } from '../middlewareLabels.utils.js';
import { callHookSafely } from './../logger.utils.js';
import { makeEventReporter, reportRejection } from './circuitBreaker.utils.js';

import type { Logger } from '../../../logger.js';
import type { VernLLMEvent } from '../../../types/events.js';
import type { AdapterInfo, AttemptContext, VernLLMMiddleware } from '../../../types/index.js';

/** The `circuitBreaker` option union, shared by `VernLLMOptions` and `buildCircuitBreaker`. */
export type CircuitBreakerOption = boolean | CircuitBreakerOptions | CircuitBreakerAdapter;

const REQUIRED_ADAPTER_METHOD_NAMES = [
  'assertClosed',
  'recordSuccess',
  'recordFailure',
  'onStateChange',
] as const;

/** Members only an adapter has. `onStateChange` is left out since plain options have it too. */
const ADAPTER_ONLY_METHOD_NAMES = ['assertClosed', 'recordSuccess', 'recordFailure'] as const;

/**
 * Optional adapter members that must be functions. `isolateByModel` is left out since plain options
 * have it as a boolean.
 */
const OPTIONAL_FUNCTION_MEMBER_NAMES = [
  'getState',
  'getFailureBreakdown',
  'open',
  'close',
  'releaseTrial',
  'setLogger',
  'prepare',
  'readState',
] as const;

/** Any of `OPTIONAL_FUNCTION_MEMBER_NAMES` present but not callable, the same mistake `rateLimitAdapter.utils.ts` guards against for `getState`. */
function invalidOptionalMembers(
  option: CircuitBreakerOptions | CircuitBreakerAdapter,
): (typeof OPTIONAL_FUNCTION_MEMBER_NAMES)[number][] {
  const candidate = option as Partial<CircuitBreakerAdapter>;
  return OPTIONAL_FUNCTION_MEMBER_NAMES.filter(
    (name) => candidate[name] !== undefined && typeof candidate[name] !== 'function',
  );
}

/** `prepareTimeoutMs` present but not a finite number greater than 0. Only meaningful on an adapter, plain `CircuitBreakerOptions` has no such field. */
function hasInvalidPrepareTimeout(option: CircuitBreakerOptions | CircuitBreakerAdapter): boolean {
  const { prepareTimeoutMs } = option as Partial<CircuitBreakerAdapter>;
  return (
    prepareTimeoutMs !== undefined && (!Number.isFinite(prepareTimeoutMs) || prepareTimeoutMs <= 0)
  );
}

/**
 * Classifies the option in one pass: plain options, a complete adapter, an incomplete adapter, or
 * options with an invalid optional member.
 */
function classifyCircuitBreakerOption(option: CircuitBreakerOptions | CircuitBreakerAdapter): {
  /** At least one of the three adapter-only methods is present, so this is clearly an attempted adapter, not plain options. */
  attemptsAdapter: boolean;
  /** Required members not present as functions. Only meaningful when `attemptsAdapter` is true. */
  missing: (typeof REQUIRED_ADAPTER_METHOD_NAMES)[number][];
  /** Present-but-non-function optional members, checked regardless of `attemptsAdapter`, see `OPTIONAL_FUNCTION_MEMBER_NAMES`. */
  invalid: (typeof OPTIONAL_FUNCTION_MEMBER_NAMES)[number][];
} {
  const candidate = option as Partial<CircuitBreakerAdapter>;
  return {
    attemptsAdapter: ADAPTER_ONLY_METHOD_NAMES.some(
      (name) => typeof candidate[name] === 'function',
    ),
    missing: REQUIRED_ADAPTER_METHOD_NAMES.filter((name) => typeof candidate[name] !== 'function'),
    invalid: invalidOptionalMembers(option),
  };
}

/**
 * Wraps a caller's `onStateChange` so every real change first reports a `circuit_state` event, then
 * calls the handler safely. Shared by the built in breaker and custom adapters.
 */
function wrapOnStateChange(
  userOnStateChange: CircuitBreakerStateChangeHandler | undefined,
  providerName: string,
  defaultModel: string,
  reportEvent: (event: VernLLMEvent) => void,
  logger: Logger,
  middleware: VernLLMMiddleware[],
  middlewareTimeoutMs: number,
  isFallback: boolean,
  supportsJsonObjectMode: boolean,
  adapter: AdapterInfo,
): CircuitBreakerStateChangeHandler {
  return (from, to, consecutiveFailures, model, context) => {
    const event: VernLLMEvent = {
      kind: 'circuit_state',
      provider: providerName,
      model: model ?? defaultModel,
      from,
      to,
      consecutiveFailures,
    };

    // `context` is absent when the breaker changes state outside any call:
    // called directly, or (for a shared adapter) a change another process
    // made. Middleware still need to see it, so it gets a fresh call
    // identity of its own, like a manual `openCircuit()`.
    const callContext = context ?? {
      requestId: globalThis.crypto.randomUUID(),
      state: createMiddlewareStateBag(),
    };

    const ctx: AttemptContext = {
      stage: 'attempt',
      requestId: callContext.requestId,
      requestedProvider: providerName,
      adapter,
      requestedModel: model ?? defaultModel,
      isFallbackAttempt: isFallback,
      // Most call sites (recordSuccess/recordFailure after a real
      // dispatch) thread a real 1 based attempt number through
      // `context.attempt`. Falls back to `1` for the sites that have
      // none, like `assertClosed`'s pre-dispatch check.
      attempt: callContext.attempt ?? 1,
      capabilities: { supportsJsonObjectMode },
      signal: callContext.signal,
      state: callContext.state,
      own: {},
      ...middlewareContextNames(middleware),
    };

    emitEvent(event, ctx, reportEvent, middleware, middlewareTimeoutMs, logger);

    // A caller supplied onStateChange would otherwise be silently
    // discarded, since this wrapper replaces it. Chain it instead, same
    // try/catch treatment as every other user supplied callback so it
    // can't break breaker bookkeeping or the call that triggered it.
    if (!userOnStateChange) return;

    callHookSafely(logger, 'circuitBreaker.onStateChange', () =>
      userOnStateChange(from, to, consecutiveFailures, model, context),
    );
  };
}

/** One subscriber set per adapter, keyed weakly. See `wireAdapterOnStateChange`. */
const adapterSubscribers = new WeakMap<
  CircuitBreakerAdapter,
  Set<CircuitBreakerStateChangeHandler>
>();

/** Adapters that have already triggered the sharing warning below, so it fires once ever per adapter, not once per every additional build against it. */
const warnedAboutSharing = new WeakSet<CircuitBreakerAdapter>();

/**
 * Subscribes a target to an adapter's state changes. The first call installs one dispatcher, rather
 * than wrapping again per target, and it calls the adapter's original handler once per transition
 * however many targets share it.
 */
function wireAdapterOnStateChange(
  adapter: CircuitBreakerAdapter,
  subscriber: CircuitBreakerStateChangeHandler,
  logger: Logger,
): void {
  let subscribers = adapterSubscribers.get(adapter);

  if (!subscribers) {
    subscribers = new Set();
    adapterSubscribers.set(adapter, subscribers);

    const originalOnStateChange = adapter.onStateChange;
    const currentSubscribers = subscribers;

    adapter.onStateChange = (from, to, consecutiveFailures, model, context) => {
      for (const sub of currentSubscribers) {
        callHookSafely(logger, 'circuitBreaker.onStateChange', () =>
          sub(from, to, consecutiveFailures, model, context),
        );
      }

      callHookSafely(logger, 'circuitBreaker.onStateChange', () =>
        originalOnStateChange(from, to, consecutiveFailures, model, context),
      );
    };
  } else if (!warnedAboutSharing.has(adapter)) {
    warnedAboutSharing.add(adapter);
    logger.warn(
      "[VernLLM] circuitBreaker: this adapter instance is already wired to another target. circuit_state events for it will now be reported to both, each tagged with its own provider/model. If that's intentional (a breaker genuinely shared across targets or clients), no action needed. If not, e.g. constructing VernLLM repeatedly with the same adapter instance, each wiring is kept for the life of the process, review whether the adapter should be constructed fresh per target instead.",
    );
  }

  subscribers.add(subscriber);
}

/**
 * Builds one target's breaker: a `CircuitBreaker`, the caller's adapter, or `undefined`. Built
 * before its executor, so it reports events through `onEvent` directly. Takes only the fields it
 * needs so primary and fallback targets use it alike.
 */
export function buildCircuitBreaker(
  circuitBreakerOption: CircuitBreakerOption | undefined,
  providerName: string,
  defaultModel: string,
  onEvent: ((event: VernLLMEvent) => void) | undefined,
  logger: Logger,
  middleware: VernLLMMiddleware[],
  middlewareTimeoutMs: number,
  isFallback: boolean,
  supportsJsonObjectMode: boolean,
  adapter: AdapterInfo = CUSTOM_ADAPTER,
): CircuitBreakerAdapter | undefined {
  if (!circuitBreakerOption) return undefined;

  const reportEvent = makeEventReporter(onEvent, logger);

  const wrap = (userOnStateChange: CircuitBreakerStateChangeHandler | undefined) =>
    wrapOnStateChange(
      userOnStateChange,
      providerName,
      defaultModel,
      reportEvent,
      logger,
      middleware,
      middlewareTimeoutMs,
      isFallback,
      supportsJsonObjectMode,
      adapter,
    );

  if (typeof circuitBreakerOption === 'object') {
    const { attemptsAdapter, missing, invalid } =
      classifyCircuitBreakerOption(circuitBreakerOption);

    if (attemptsAdapter && missing.length > 0) {
      throw new LLMError(
        `circuitBreaker looks like a CircuitBreakerAdapter but is missing: ${missing.join(', ')}. All four members (${REQUIRED_ADAPTER_METHOD_NAMES.join(', ')}) are required.`,
        'invalid_params',
      );
    }

    if (attemptsAdapter && hasInvalidPrepareTimeout(circuitBreakerOption)) {
      throw new LLMError(
        `circuitBreaker's prepareTimeoutMs (${String((circuitBreakerOption as Partial<CircuitBreakerAdapter>).prepareTimeoutMs)}) must be a finite number greater than 0. It is optional, omit it to use the default.`,
        'invalid_params',
      );
    }

    if (invalid.length > 0) {
      const candidate = circuitBreakerOption as Partial<CircuitBreakerAdapter>;
      const described = invalid.map((name) => `${name} (${typeof candidate[name]})`).join(', ');

      throw new LLMError(
        `circuitBreaker's ${described} must be a function when present. ${invalid.length === 1 ? 'It is' : 'They are'} optional, omit entirely rather than assigning a non function value.`,
        'invalid_params',
      );
    }

    // A complete adapter keeps its own state; VernLLM only subscribes through the shared
    // dispatcher. The dispatcher calls the adapter's original handler, so this subscriber passes
    // `undefined` to avoid calling it once per target.
    if (attemptsAdapter) {
      const adapter = circuitBreakerOption as CircuitBreakerAdapter;
      wireAdapterOnStateChange(adapter, wrap(undefined), logger);
      // Declared `void`, but an async adapter may return a promise anyway.
      reportRejection(
        logger,
        '[VernLLM] circuitBreaker.setLogger rejected',
        adapter.setLogger?.(logger),
      );

      return adapter;
    }
  }

  const breakerOptions =
    typeof circuitBreakerOption === 'object' ? circuitBreakerOption : undefined;

  return new CircuitBreaker({
    ...breakerOptions,
    onStateChange: wrap(breakerOptions?.onStateChange),
  });
}
