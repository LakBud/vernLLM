import { unrefTimer } from '../../shared/timing/timers.utils.js';
import {
  buildTransitionArgs,
  parseTransitionResult,
  type TransitionConfig,
  type TransitionOutcome,
} from '../scripts/transitionResult.utils.js';
import { TRANSITION_SCRIPT } from '../scripts/transitionScript.js';
import { bucketKey } from '../state/bucketKey.utils.js';
import { applyObservation, type Change } from '../state/observe.utils.js';

import type { RedisClient } from '../../../types.js';
import type { AdapterLogger } from '../../shared/logger.utils.js';
import type { LocalCircuitCache } from '../state/localCache.utils.js';
import type { CircuitBreakerCallContext } from 'vern-llm';

export interface TransitionOptions {
  /** '' for none, '*' for no call context, which always counts. */
  token?: string;
  code?: string;
  /** Whether a 'check' may win a half-open trial slot. Default true. */
  grant?: boolean;
}

/** Told after every transition whether Redis answered with a usable reply, and when one stalls. */
export interface Reachability {
  up(): void;
  down(): void;
}

/** Reports through the adapter's current onStateChange. */
export type Notify = (
  change: Change | undefined,
  model: string | undefined,
  context: CircuitBreakerCallContext | undefined,
) => void;

export interface TransitionRunner {
  /** Runs one outcome through the script and applies the reply. */
  transition(
    model: string | undefined,
    outcome: TransitionOutcome,
    opts?: TransitionOptions,
  ): Promise<Change | undefined>;
  /** `transition` fire and forget, logging failures. */
  run(
    operation: string,
    model: string | undefined,
    outcome: TransitionOutcome,
    context: CircuitBreakerCallContext | undefined,
    opts?: TransitionOptions,
  ): Promise<void>;
}

export function createTransitionRunner(deps: {
  redis: RedisClient;
  config: TransitionConfig & { isolateByModel: boolean; keyPrefix: string; channel: string };
  local: LocalCircuitCache;
  log: AdapterLogger;
  notify: Notify;
  reachability: Reachability;
  /** A transition still pending after this long counts as Redis being down. The call carries on. */
  stallMs: number;
}): TransitionRunner {
  const { redis, config, local, log, notify, reachability, stallMs } = deps;
  const { isolateByModel, keyPrefix, channel } = config;

  async function transition(
    model: string | undefined,
    outcome: TransitionOutcome,
    opts: TransitionOptions = {},
  ): Promise<Change | undefined> {
    const key = bucketKey(keyPrefix, isolateByModel, model);

    // A hung connection rejects nothing, often for a long while, so a stall is a signal too. The
    // timer only arms a check one event loop turn later: after a blocked loop it can fire before a
    // reply that already arrived is read, and that reply must win.
    let settled = false;
    const stall = setTimeout(() => {
      setImmediate(() => !settled && reachability.down());
    }, stallMs);
    unrefTimer(stall);

    let result: ReturnType<typeof parseTransitionResult>;
    try {
      result = parseTransitionResult(
        await redis.eval(
          TRANSITION_SCRIPT,
          1,
          key,
          ...buildTransitionArgs(config, {
            outcome,
            channel,
            token: opts.token ?? '',
            grant: opts.grant !== false,
            code: opts.code ?? '',
            rand: Math.random(),
          }),
        ),
      );
    } catch (error) {
      reachability.down();
      throw error;
    } finally {
      settled = true;
      clearTimeout(stall);
    }
    reachability.up();

    return applyObservation(local, key, {
      from: result.from,
      state: result.to,
      failures: result.failures,
      openedAt: result.openedAt,
      version: result.version,
      timing: result,
      breakdown: result.breakdown,
      epoch: result.epoch,
      wonToken: result.wonProbe ? result.probeToken : undefined,
    });
  }

  return {
    transition,

    run(operation, model, outcome, context, opts) {
      return transition(model, outcome, opts)
        .then((change) => notify(change, model, context))
        .catch((error: unknown) =>
          log.failure(operation, error, bucketKey(keyPrefix, isolateByModel, model)),
        );
    },
  };
}
