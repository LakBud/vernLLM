import type { CircuitBreaker, CircuitBreakerCallContext } from '../../circuitBreaker.js';
import type { AttemptContext, LLMErrorCode, MiddlewareStateBag } from '../../types/index.js';

/** Everything one logical call needs to build attempt context and talk to its breaker. */
export interface BreakerGatewayOptions {
  breaker?: CircuitBreaker;
  requestId: string;
  model: string;
  providerName: string;
  isFallback: boolean;
  supportsJsonObjectMode: boolean;
  /** `MiddlewarePipeline.names`, threaded through for `AttemptContext.registeredMiddlewareNames`. */
  registeredMiddlewareNames: readonly string[];
}

/**
 * Builds `AttemptContext`/`CircuitBreakerCallContext` for one logical
 * call's attempts, and records success/failure against `breaker`.
 * `attempt` stays 0-based at every call site; the 1-based conversion
 * happens once, inside `buildCallContext`/`buildAttemptContext`.
 */
export interface BreakerGateway {
  buildAttemptContext(
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ): AttemptContext;
  buildCallContext(
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ): CircuitBreakerCallContext;
  /** No-op if no breaker was configured. */
  recordSuccess(attempt: number, signal: AbortSignal | undefined, state: MiddlewareStateBag): void;
  /** No-op if no breaker was configured. `code`, when present, is forwarded to the breaker for future attribution use. */
  recordFailure(
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
    code?: LLMErrorCode,
  ): void;
}

export function createBreakerGateway(options: BreakerGatewayOptions): BreakerGateway {
  const {
    breaker,
    requestId,
    model,
    providerName,
    isFallback,
    supportsJsonObjectMode,
    registeredMiddlewareNames,
  } = options;

  function buildAttemptContext(
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ): AttemptContext {
    return {
      stage: 'attempt',
      requestId,
      requestedProvider: providerName,
      requestedModel: model,
      isFallbackAttempt: isFallback,
      attempt: attempt + 1,
      capabilities: { supportsJsonObjectMode },
      signal,
      state,
      own: {},
      registeredMiddlewareNames,
    };
  }

  function buildCallContext(
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ): CircuitBreakerCallContext {
    return { requestId, state, signal, attempt: attempt + 1 };
  }

  return {
    buildAttemptContext,
    buildCallContext,
    recordSuccess(attempt, signal, state) {
      breaker?.recordSuccess(model, buildCallContext(attempt, signal, state));
    },
    recordFailure(attempt, signal, state, code) {
      breaker?.recordFailure(model, buildCallContext(attempt, signal, state), code);
    },
  };
}
