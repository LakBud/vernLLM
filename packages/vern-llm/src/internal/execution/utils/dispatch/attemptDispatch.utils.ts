import { toRequestSnapshot, type LLMRequestSnapshot } from '../../../../types/errors.js';
import { createMiddlewareStateBag } from '../../../../types/middleware.js';
import { applyMiddlewareTransforms, emitEvent } from '../middleware.utils.js';
import { acquireRateLimit } from './rateLimitDispatch.utils.js';

import type { Logger } from '../../../../logger.js';
import type { RateLimiter } from '../../../../rateLimit.js';
import type {
  CallParams,
  MiddlewareStateBag,
  VernLLMEvent,
  VernLLMMiddleware,
  WireCallRequest,
} from '../../../../types/index.js';
import type { BreakerGateway } from '../../circuitBreakerContext.js';
import type { RequestBuilder } from '../../requestBuilder.js';

/**
 * `executeCall`/`executeStreamCall` call `onRequest` with a fully built
 * `LLMRequestSnapshot`, right after the outgoing payload is built and
 * before dispatch. See the fuller comment where it's used, moved here
 * since `prepareAttempt` is where it's actually invoked.
 */
export type OnRequest = (snapshot: LLMRequestSnapshot) => void;

/** Everything `prepareAttempt` needs beyond the per-attempt request params. */
export interface PrepareAttemptParams<T> {
  params: CallParams<T>;
  requestId: string;
  attempt: number;
  onRequest: OnRequest | undefined;
  middlewareState: MiddlewareStateBag | undefined;
  gateway: BreakerGateway;
  requestBuilder: RequestBuilder;
  providerName: string;
  limiter: RateLimiter | undefined;
  middleware: VernLLMMiddleware[];
  middlewareTimeoutMs: number;
  logger: Logger;
  reportEvent: (event: VernLLMEvent) => void;
}

/** Everything one dispatched attempt needs before it proceeds, shared by the non-streaming and streaming paths. */
export interface PreparedAttempt {
  request: WireCallRequest;
  model: string;
  useJson: boolean;
  state: MiddlewareStateBag;
  /**
   * Present unless no `limiter` was configured. Must run in a `finally`
   * block so a slot is never leaked on a failed attempt (see `acquireRateLimit`).
   */
  release?: (actualTokens?: number) => void;
}

/**
 * Everything `executeCall` and `executeStreamCall` do before they diverge:
 * build the wire request, run middleware `transform`s, snapshot the
 * outgoing payload through `onRequest`, and acquire rate limit capacity
 * for this attempt. Pulled out so the two dispatch paths don't drift
 * independently.
 */
export async function prepareAttempt<T>(p: PrepareAttemptParams<T>): Promise<PreparedAttempt> {
  const {
    params,
    requestId,
    attempt,
    onRequest,
    middlewareState,
    gateway,
    requestBuilder,
    providerName,
    limiter,
    middleware,
    middlewareTimeoutMs,
    logger,
    reportEvent,
  } = p;

  const state = middlewareState ?? createMiddlewareStateBag();
  const built = requestBuilder.build(params);
  const { useJson, model } = built;

  const request = await applyMiddlewareTransforms({
    request: built.request,
    requestId,
    attempt,
    signal: params.signal,
    state,
    middleware,
    middlewareTimeoutMs,
    logger,
    reportEvent,
    buildContext: (attempt, signal, state) => gateway.buildAttemptContext(attempt, signal, state),
  });

  onRequest?.(toRequestSnapshot(providerName, model, request, undefined, Date.now()));

  const { release } = await acquireRateLimit(
    limiter,
    request,
    params.signal,
    (waitedMs, reason) => {
      emitEvent(
        {
          kind: 'rate_limited',
          requestId,
          provider: providerName,
          model,
          waitedMs,
          reason,
        },
        gateway.buildAttemptContext(attempt, params.signal, state),
        reportEvent,
        middleware,
        middlewareTimeoutMs,
        logger,
      );
    },
  );

  return { request, model, useJson, state, release };
}
