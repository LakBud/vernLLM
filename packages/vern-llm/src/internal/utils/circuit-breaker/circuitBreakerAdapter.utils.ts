import {
  CircuitBreaker,
  type CircuitBreakerAdapter,
  type CircuitBreakerOptions,
  type CircuitBreakerStateChangeHandler,
} from '../../../circuitBreaker.js';
import { LLMError } from '../../../types/errors.js';
import { emitEvent } from '../../execution/utils/middleware/middleware.utils.js';
import { idFor } from '../../resolveMiddlewareOrder.js';
import { callHookSafely } from './../logger.utils.js';
import { makeEventReporter } from './circuitBreaker.utils.js';

import type { Logger } from '../../../logger.js';
import type { VernLLMEvent } from '../../../types/events.js';
import type { AttemptContext, VernLLMMiddleware } from '../../../types/index.js';

/**
 * Not re-exported from the package root, imported directly from this
 * internal module by `VernLLMOptions.circuitBreaker`'s own type (see
 * options.ts) so that union isn't duplicated between the public option
 * field and `buildCircuitBreaker`'s own signature below, same pattern
 * `CacheOption` and `RateLimitOption` already use for their own options.
 */
export type CircuitBreakerOption = boolean | CircuitBreakerOptions | CircuitBreakerAdapter;

const REQUIRED_ADAPTER_METHOD_NAMES = [
  'assertClosed',
  'recordSuccess',
  'recordFailure',
  'onStateChange',
] as const;

/**
 * Method names that exist only on `CircuitBreakerAdapter`, never on plain
 * `CircuitBreakerOptions`. `onStateChange` is deliberately excluded here,
 * it's a legitimate `CircuitBreakerOptions` field too (`circuitBreaker: {
 * threshold: 5, onStateChange: fn }`), so its presence alone must not be
 * read as "this is an attempted adapter". These three are the only
 * unambiguous signal.
 */
const ADAPTER_ONLY_METHOD_NAMES = ['assertClosed', 'recordSuccess', 'recordFailure'] as const;

/**
 * Optional `CircuitBreakerAdapter` members that only make sense as
 * functions, and never appear on plain `CircuitBreakerOptions`, so any
 * non function value assigned to one is unambiguously a mistake.
 * `isolateByModel` is deliberately excluded: it's a legitimate
 * `CircuitBreakerOptions` field too (a real boolean, not a function), so
 * validating its type here isn't this check's job.
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
 * Computes, in one pass, everything `buildCircuitBreaker` needs to decide
 * between plain options, a complete adapter, an incomplete adapter, and
 * an otherwise-plain object with an invalid optional member. Replaces
 * what used to be three separate functions each re-deriving overlapping
 * facts about the same candidate object.
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
 * Wraps a caller supplied `onStateChange` (from `CircuitBreakerOptions` or
 * from a `CircuitBreakerAdapter`) so every real state change also reports
 * a `circuit_state` event, then chains into the original handler, safely.
 * One shared implementation so the built in `CircuitBreaker` and a custom
 * `CircuitBreakerAdapter` report events the exact same way.
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

    // `context` is absent only when someone calls the breaker or adapter
    // directly, bypassing `VernLLM`.
    if (context) {
      const ctx: AttemptContext = {
        stage: 'attempt',
        requestId: context.requestId,
        requestedProvider: providerName,
        requestedModel: model ?? defaultModel,
        isFallbackAttempt: isFallback,
        // Most call sites (recordSuccess/recordFailure after a real
        // dispatch) now thread a real 1 based attempt number through
        // `context.attempt`. Falls back to `1` only for the sites
        // that genuinely have none, like `assertClosed`'s
        // pre-dispatch check, which runs before any attempt exists.
        attempt: context.attempt ?? 1,
        capabilities: { supportsJsonObjectMode },
        signal: context.signal,
        state: context.state,
        own: {},
        registeredMiddlewareNames: middleware.map(idFor),
      };

      emitEvent(event, ctx, reportEvent, middleware, middlewareTimeoutMs, logger);
    } else {
      reportEvent(event);
    }

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

/**
 * One dispatcher `Set` per `CircuitBreakerAdapter` instance, keyed by
 * object identity so it never leaks a strong reference of its own.
 * `wireAdapterOnStateChange` reads/writes this instead of letting
 * `buildCircuitBreaker` reassign `adapter.onStateChange` directly on
 * every call, see that function's doc comment for why.
 */
const adapterSubscribers = new WeakMap<
  CircuitBreakerAdapter,
  Set<CircuitBreakerStateChangeHandler>
>();

/** Adapters that have already triggered the sharing warning below, so it fires once ever per adapter, not once per every additional build against it. */
const warnedAboutSharing = new WeakSet<CircuitBreakerAdapter>();

/**
 * Registers `subscriber` against `adapter`, installing one dispatcher onto
 * `adapter.onStateChange` the first time this adapter is seen instead of
 * wrapping it again on every call, which would silently chain deeper for
 * every target that ever shared this adapter. The dispatcher calls every
 * subscribed target's own tagged handler plus the adapter's original
 * `onStateChange` exactly once per real transition, no matter how many
 * targets share it.
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
 * Builds the optional circuit breaker for one provider target, resolving
 * `circuitBreakerOption` into a real `CircuitBreaker`, a caller supplied
 * `CircuitBreakerAdapter`, or `undefined` when it's falsy, matching the
 * option's own semantics.
 *
 * Lives outside `CallExecutor` (and outside `VernLLM`, once this were
 * inlined) because the breaker has to exist *before* the executor it's
 * passed into, so its construction can't be an executor concern.
 * `onEvent` is called directly rather than through the executor for the
 * same reason: nothing executor-shaped exists yet at this point.
 *
 * Takes the specific fields it needs (rather than a full `VernLLMOptions`)
 * so it works identically for the primary target and for each fallback
 * target, which carry their own `circuitBreaker` override alongside the
 * shared `onEvent`/`middleware`.
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

    // A full adapter keeps its own state and dispatch logic. VernLLM only
    // subscribes to its `onStateChange` through `wireAdapterOnStateChange`,
    // which installs one shared dispatcher the first time this adapter is
    // seen, so sharing one adapter across targets is explicit and bounded
    // rather than an invisible, ever-growing call chain. See that
    // function's doc comment. This subscriber only reports the event,
    // `wireAdapterOnStateChange` itself calls the adapter's real original
    // `onStateChange` exactly once per transition, so passing `undefined`
    // here avoids calling it once per subscribing target instead of once
    // total.
    //
    // Reaching here means `attemptsAdapter` is true (or the function
    // would already have returned/thrown above) and both `missing` and
    // `invalid` are empty, so `circuitBreakerOption` is a complete,
    // valid `CircuitBreakerAdapter`.
    if (attemptsAdapter) {
      const adapter = circuitBreakerOption as CircuitBreakerAdapter;
      wireAdapterOnStateChange(adapter, wrap(undefined), logger);
      adapter.setLogger?.(logger);
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
