import {
  LLMError,
  type CircuitBreakerAdapter,
  type CircuitBreakerStateChangeHandler,
  type LLMErrorCode,
} from 'vern-llm';

import { createPermits } from './internal/circuit-breaker/calls/permits.utils.js';
import { createRefresher, needsRefresh } from './internal/circuit-breaker/calls/prepare.utils.js';
import {
  createTransitionRunner,
  type Notify,
} from './internal/circuit-breaker/calls/transport.utils.js';
import { resolveCircuitBreakerOptions } from './internal/circuit-breaker/circuitBreakerOptions.utils.js';
import {
  READ_BUCKETS_SCRIPT,
  parseSnapshotResult,
} from './internal/circuit-breaker/scripts/snapshotScript.js';
import { parseTransitionMessage } from './internal/circuit-breaker/scripts/transitionResult.utils.js';
import { bucketKey, modelFromKey } from './internal/circuit-breaker/state/bucketKey.utils.js';
import { createLocalCircuitCache } from './internal/circuit-breaker/state/localCache.utils.js';
import { applyObservation } from './internal/circuit-breaker/state/observe.utils.js';
import { seedFromScan } from './internal/circuit-breaker/state/seed.utils.js';
import { toRedisError } from './internal/shared/errors/redisError.utils.js';
import { createAdapterLogger, type AdapterLoggerOption } from './internal/shared/logger.utils.js';
import { withScriptCache } from './internal/shared/redis/scriptCache.utils.js';
import { attachSubscriber } from './internal/shared/redis/subscriber.utils.js';
import { createHeartbeats } from './internal/shared/timing/heartbeat.utils.js';
import { createPoller } from './internal/shared/timing/poller.utils.js';

import type { RedisClient, RedisSubscriber } from './types.js';

/** Grows the cooldown on each repeat open, with jitter. */
export interface RedisCooldownBackoff {
  /** Growth per repeat open, e.g. 2 doubles it. */
  multiplier: number;
  /** Cap on the cooldown, in ms. Default unbounded. */
  maxMs?: number;
}

/** When failures open the circuit. Same shapes as core's `tripping`. */
export type RedisTrippingOption =
  | { kind: 'consecutive'; threshold: number }
  | { kind: 'rolling'; windowMs: number; minCalls: number; failureRatio: number };

export interface RedisCircuitBreakerOptions {
  /** Consecutive failures before opening, an integer of at least 1. Default 5. */
  threshold?: number;
  /** Time open before a trial, in ms. Default 30000. */
  cooldownMs?: number;
  /** A separate circuit per model. Default false. */
  isolateByModel?: boolean;
  /** Prefix for every key. Default "vernllm:cb". */
  keyPrefix?: string;
  onStateChange?: CircuitBreakerStateChangeHandler;
  /** A dedicated pub/sub connection, so every process hears a change at once. Recommended. */
  subscriber?: RedisSubscriber;
  /** Recheck interval for touched keys without a subscriber, in ms. Default 5000, `0` disables. */
  pollIntervalMs?: number;
  /** Trial calls per half-open cycle, across every process. Default 1. */
  halfOpenProbes?: number;
  /** Share of trials that must succeed to close, in [0, 1]. Default 1. */
  halfOpenSuccessRatio?: number;
  /** Exponential cooldown growth. Core's function form can't run in Redis. */
  cooldownBackoff?: RedisCooldownBackoff;
  /** Consecutive (default) or rolling window. A custom policy can't run in Redis. */
  tripping?: RedisTrippingOption;
  /** How long an unreported trial slot is held before reclaim, in ms. Default 60000. */
  probeLeaseMs?: number;
  /** How long VernLLM waits for `prepare`, in ms. Default 250. */
  prepareTimeoutMs?: number;
  /** Where background failures go. Defaults to the VernLLM logger. `'silent'` discards them. */
  logger?: AdapterLoggerOption;
}

/** A `CircuitBreakerAdapter` with a `dispose` method. */
export interface RedisCircuitBreakerAdapter extends CircuitBreakerAdapter {
  /** Stops the poll, renewals and subscriber. Call before closing the client. Idempotent. */
  dispose(): void;
}

/** A CircuitBreakerAdapter backed by Redis, shared by every process using the same keys. */
export function redisCircuitBreaker(
  client: RedisClient,
  options: RedisCircuitBreakerOptions = {},
): RedisCircuitBreakerAdapter {
  const redis = withScriptCache(client);
  const config = resolveCircuitBreakerOptions(options);
  const { isolateByModel, keyPrefix, channel, pollIntervalMs, probeLeaseMs, prepareTimeoutMs } =
    config;

  const local = createLocalCircuitCache();
  const log = createAdapterLogger('redisCircuitBreaker', options.logger);
  const heartbeats = createHeartbeats();
  const refresher = createRefresher(prepareTimeoutMs);
  const keyFor = (model: string | undefined) => bucketKey(keyPrefix, isolateByModel, model);

  let disposed = false;
  /** Last call per key, so an idle process's poll never wins a slot. */
  const lastDemandAt = new Map<string, number>();
  /** Keys with a slot request from `assertClosed` still in flight. One at a time, so retries can't win extra slots. */
  const grantsInFlight = new Set<string>();

  // Looked up per report: core may wrap onStateChange after construction.
  const notify: Notify = (change, model, context) => {
    if (change) adapter.onStateChange(change.from, change.to, change.failures, model, context);
  };

  const { transition, run } = createTransitionRunner({ redis, config, local, log, notify });

  const permits = createPermits({
    heartbeats,
    probeLeaseMs,
    renew: (model, token) => void run('trial lease renewal', model, 'renew', undefined, { token }),
  });

  const poller = createPoller(
    pollIntervalMs,
    () => {
      const now = Date.now();

      for (const key of [...local.keys()]) {
        const model = modelFromKey(key, keyPrefix, isolateByModel);
        const recentDemand = now - (lastDemandAt.get(key) ?? 0) < pollIntervalMs * 2;

        void transition(model, 'check', { grant: recentDemand })
          .then((change) => notify(change, model, undefined))
          .catch((error: unknown) => log.failure('poll transition', error, key));
      }
    },
    () => disposed,
  );

  void seedFromScan(redis, local, keyPrefix, () => disposed).catch((error: unknown) =>
    log.failure('snapshot', error, keyPrefix),
  );

  const detachSubscriber = options.subscriber
    ? attachSubscriber(options.subscriber, channel, {
        isDisposed: () => disposed,
        onMessage(message) {
          const parsed = parseTransitionMessage(message);
          if (!parsed) return;

          notify(
            applyObservation(local, parsed.key, { ...parsed, timing: parsed }),
            modelFromKey(parsed.key, keyPrefix, isolateByModel),
            undefined,
          );
        },
        onSubscribeError(error) {
          log.failure('subscribe', error, channel);
          poller.start();
        },
      })
    : undefined;

  if (!options.subscriber) poller.start();

  const adapter: RedisCircuitBreakerAdapter = {
    isolateByModel,

    getState(model) {
      return local.get(keyFor(model)).state;
    },

    getFailureBreakdown(model) {
      return { ...local.get(keyFor(model)).breakdown } as Partial<
        Record<LLMErrorCode | 'unknown', number>
      >;
    },

    assertClosed(model, context) {
      const key = keyFor(model);
      const bucket = local.get(key);
      const priorState = bucket.state;
      lastDemandAt.set(key, Date.now());

      // Spent synchronously, so a concurrent call can't take the same slot.
      let allowed = false;
      if (priorState === 'closed') {
        allowed = true;
      } else if (priorState === 'half-open' && bucket.trialsHeld > 0) {
        bucket.trialsHeld -= 1;
        allowed = true;
        if (context) permits.grant(context, key, model, bucket.trialToken);
      }

      // Only a rejected call may win a slot, and only one request per key at a time.
      const grant = !allowed && !grantsInFlight.has(key);
      if (grant) grantsInFlight.add(key);
      void run('assertClosed transition', model, 'check', context, { grant }).finally(() => {
        if (grant) grantsInFlight.delete(key);
      });

      if (!allowed) {
        throw priorState === 'half-open'
          ? new LLMError(
              `Circuit half-open, no trial available for ${model ?? 'default'}`,
              'circuit_open',
              { code: 'circuit_trial_in_flight' },
            )
          : new LLMError(`Circuit open for ${model ?? 'default'}`, 'circuit_open', {
              code: 'circuit_cooling_down',
            });
      }
    },

    recordSuccess(model, context) {
      void run('recordSuccess transition', model, 'success', context, {
        token: permits.takeToken(keyFor(model), context),
      });
    },

    recordFailure(model, context, code) {
      void run('recordFailure transition', model, 'failure', context, {
        token: permits.takeToken(keyFor(model), context),
        code,
      });
    },

    releaseTrial(model, context) {
      if (!context) return;

      const permit = permits.take(keyFor(model), context);
      if (!permit) return;

      void run('releaseTrial transition', model, 'release', context, { token: permit.token });
    },

    open(model, context) {
      void run('open transition', model, 'open', context);
    },

    close(model, context) {
      void run('close transition', model, 'close', context);
    },

    prepareTimeoutMs,

    /** Refreshes the local copy when that could change `assertClosed`. */
    prepare(model) {
      if (disposed) return Promise.resolve();

      const key = keyFor(model);
      lastDemandAt.set(key, Date.now());
      if (!needsRefresh(local, key, probeLeaseMs)) return Promise.resolve();

      return refresher.run(key, async () => {
        try {
          notify(await transition(model, 'check'), model, undefined);
        } catch (error) {
          throw toRedisError('prepare', error);
        }
      });
    },

    async readState(model) {
      const key = keyFor(model);
      const entry = parseSnapshotResult(
        await redis.eval(READ_BUCKETS_SCRIPT, 1, key, '1').catch((error: unknown) => {
          throw toRedisError('readState', error);
        }),
      );

      // Unversioned (expired or never versioned): the live read wins.
      const observed = entry ?? { state: 'closed' as const, failures: 0, openedAt: 0, version: 0 };
      notify(applyObservation(local, key, observed, observed.version === 0), model, undefined);
      return observed.state;
    },

    onStateChange: options.onStateChange ?? (() => {}),

    setLogger(logger) {
      log.adopt(logger);
    },

    dispose() {
      disposed = true;
      log.mute();

      poller.stop();
      heartbeats.stopAll();
      lastDemandAt.clear();
      grantsInFlight.clear();
      refresher.clear();
      detachSubscriber?.();
    },
  };

  return adapter;
}
