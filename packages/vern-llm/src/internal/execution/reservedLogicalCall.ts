import { LLMError } from '../../types/errors.js';
import {
  executeLogicalCall,
  executeLogicalStreamCall,
  modelForTarget,
  type LogicalCallDependencies,
} from './logicalCall.js';
import { withReservedUsage, withReservedUsageForStream } from './utils/response/usage.utils.js';
import { cancelOnBreak } from './utils/stream/earlyExit.utils.js';

import type { CallMeta, CallParams, CallResult } from '../../types/index.js';
import type { MiddlewareStateBag } from '../../types/middleware.js';

export interface ReservedLogicalCallOptions {
  requestId: string;
  middlewareState: MiddlewareStateBag;
  /** Aborted when the caller leaves `chunks` early. See `setupCallSignal`. */
  breakController: AbortController | undefined;
  onRefundError: (logMessage: string, error: unknown) => void;
}

/**
 * The part of `call()` inside `wrap`: the sole target breaker check, usage
 * reservation, then the logical call over `dependencies.targets`.
 *
 * With one target the breaker is checked here, before usage is reserved, so a
 * blocked call never pays a reserve and refund round trip. That also covers a
 * call narrowed to one target. With more, the check stays inside
 * `runFallbackChain`, since claiming a half-open trial must happen once per
 * call and an open first target is just another target failure there.
 */
export async function runReservedLogicalCall<T>(
  dependencies: LogicalCallDependencies,
  params: CallParams<T>,
  { requestId, middlewareState, breakController, onRefundError }: ReservedLogicalCallOptions,
): Promise<CallResult> {
  const soleTarget = dependencies.targets.length === 1;
  // The per call `model` override belongs to the primary only, so a sole fallback runs its own.
  const soleModel = modelForTarget(params, dependencies.targets[0]!.index);
  const breakerContext = () => ({ requestId, state: middlewareState, signal: params.signal });

  if (soleTarget) {
    // An abort during `wrap` must not claim the trial: the call would then fail
    // before any outcome is recorded and leave the breaker stuck mid-trial.
    if (params.signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    const checking = dependencies.targets[0]!.executor.assertBreakerClosed(
      soleModel,
      breakerContext(),
    );
    // Only a breaker with `prepare` hands back something to wait for.
    if (checking) await checking;
  }

  try {
    let meta: CallMeta | undefined;
    const captureMeta = async <V>(result: Promise<{ value: V; meta?: CallMeta }>) => {
      const settled = await result;
      meta = settled.meta;
      return settled.value;
    };

    if (params.stream) {
      // Refund and reporting wait on `finalResult`, since the outcome is only
      // known after `call()` has returned the stream.
      const value = await withReservedUsageForStream(
        params,
        () =>
          captureMeta(
            executeLogicalStreamCall(dependencies, params, requestId, soleTarget, middlewareState),
          ),
        params.signal,
        onRefundError,
      );

      // Wrapped inside `wrap`, so middleware hands back the same cancelling `chunks`.
      return { value: cancelOnBreak(value, breakController), meta };
    }

    const value = await withReservedUsage(
      params,
      false,
      () =>
        captureMeta(
          executeLogicalCall(dependencies, params, requestId, soleTarget, middlewareState),
        ),
      params.signal,
      onRefundError,
    );

    return { value, meta };
  } catch (error) {
    // A trial may have been claimed above; releasing is idempotent if the
    // fallback chain already did.
    if (soleTarget) {
      dependencies.targets[0]!.executor.releaseBreakerTrial(soleModel, breakerContext());
    }
    throw error;
  }
}
