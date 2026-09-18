import {
  LLMError,
  type CircuitBreakerAdapter,
  type CircuitBreakerCallContext,
  type CircuitBreakerStateChangeHandler,
  type CircuitState,
} from 'vern-llm';

import { bucketKey, modelFromKey } from './internal/circuit-breaker/bucketKey.utils.js';
import {
  createLocalCircuitCache,
  type LocalCircuitBucket,
} from './internal/circuit-breaker/localCache.utils.js';
import {
  READ_BUCKETS_SCRIPT,
  parseSnapshotResult,
} from './internal/circuit-breaker/snapshotScript.js';
import {
  TRANSITION_SCRIPT,
  parseTransitionMessage,
  parseTransitionResult,
} from './internal/circuit-breaker/transitionScript.js';

import type { RedisClient, RedisSubscriber } from './types.js';

export interface RedisCircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. Default 5. */
  threshold?: number;
  /** How long the circuit stays open before a trial request is allowed, in ms. Default 30000. */
  cooldownMs?: number;
  /** Track a separate circuit per model instead of one shared bucket. Default false. */
  isolateByModel?: boolean;
  /** Prefix for every Redis key this adapter writes. Default "vernllm:cb". */
  keyPrefix?: string;
  onStateChange?: CircuitBreakerStateChangeHandler;
  /**
   * A dedicated pub/sub connection (e.g. `mainClient.duplicate()` on
   * ioredis, or `fromNodeRedisSubscriber` for node-redis). When set,
   * every real state change is published and every process holding this
   * adapter updates its local cache the moment the message arrives,
   * typically within a few ms. Strongly recommended.
   */
  subscriber?: RedisSubscriber;
  /**
   * Without a subscriber, a transition from another process is only
   * picked up on this process's own next call for that key, which can
   * lag arbitrarily on an idle key. This poll bounds that: every
   * pollIntervalMs, every touched key is re-checked against Redis.
   * Default 5000, set 0 to disable. Skipped while a subscriber is
   * connected; used as a fallback if it fails to connect.
   */
  pollIntervalMs?: number;
}

/**
 * A CircuitBreakerAdapter backed by Redis, so circuit state is shared
 * across every process talking to the same key.
 *
 * assertClosed is synchronous, so it reads the local cache: an unseen key
 * defaults to closed and may be allowed through before Redis has confirmed
 * it, while half-open access requires a Redis-confirmed trial, never a
 * local guess. See the "assertClosed is synchronous, Redis isn't" callout
 * in the docs (/docs/integrations/redis/features/circuit-breaker) for the
 * trade-offs this implies for cooldown races and unseen keys.
 *
 * The cache stays fresh via pub/sub (`subscriber`) if supplied,
 * otherwise via polling (`pollIntervalMs`).
 */
export function redisCircuitBreaker(
  redis: RedisClient,
  options: RedisCircuitBreakerOptions = {},
): CircuitBreakerAdapter {
  const threshold = options.threshold ?? 5;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const isolateByModel = options.isolateByModel ?? false;
  const keyPrefix = options.keyPrefix ?? 'vernllm:cb';
  const channel = `${keyPrefix}:events`;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;

  const local = createLocalCircuitCache();

  // Every fire-and-forget Redis call below (transition, subscribe) is
  // reported here instead of becoming an unhandled rejection if it fails.
  function reportRejection(operation: string, key: string, error: unknown): void {
    console.error(`[redisCircuitBreaker] ${operation} failed for key "${key}":`, error);
  }

  // Bounds staleness for a key this process has touched but received no
  // further calls or pub/sub messages for. Started immediately when
  // there's no subscriber, and also as a fallback if a configured
  // subscriber's initial subscribe() never succeeds, since pub/sub can
  // then never take over convergence duty the way it normally would.
  let pollingStarted = false;
  function startPolling(): void {
    if (pollingStarted || pollIntervalMs <= 0) return;
    pollingStarted = true;

    const timer = setInterval(() => {
      for (const key of [...local.keys()]) {
        const model = modelFromKey(key, keyPrefix, isolateByModel);
        void transition(model, 'check')
          .then(({ from, to, failures }) => maybeFire(from, to, failures, model, undefined))
          .catch((error: unknown) => reportRejection('poll transition', key, error));
      }
    }, pollIntervalMs) as unknown as { unref?: () => void };

    // Prevents this background poll from keeping a short-lived process
    // (a script, a test, a serverless invocation) alive on its own.
    // Not available in every environment (e.g. browsers), guarded.
    timer.unref?.();
  }

  async function transition(
    model: string | undefined,
    outcome: 'check' | 'success' | 'failure',
  ): Promise<{ key: string; from: CircuitState; to: CircuitState; failures: number }> {
    const key = bucketKey(keyPrefix, isolateByModel, model);

    // Captured before local.set below overwrites it. This process's own
    // prior local state, not Redis's `from`, is what maybeFire compares
    // `to` against: if a pub/sub message (or an earlier call) already
    // brought this process's local cache to `to`, that's a no-op from
    // this process's perspective and must not fire a duplicate callback,
    // even though Redis's own bucket genuinely moved through `from`.
    const priorBucket = local.get(key);
    const priorLocalState = priorBucket.state;

    const { to, failures, wonProbe, openedAt } = parseTransitionResult(
      await redis.eval(
        TRANSITION_SCRIPT,
        1,
        key,
        Date.now(),
        threshold,
        cooldownMs,
        outcome,
        channel,
      ),
    );

    // Re-read the live bucket now, right before writing, not the
    // priorBucket snapshot captured before the await above. local.set()
    // below replaces the map entry wholesale rather than mutating it in
    // place, so another call's write could have landed while this one
    // was in flight; reading fresh here means an in-flight call with a
    // stale snapshot can never clobber a newer grant with an old false.
    const trialAvailable = to === 'half-open' ? wonProbe || local.get(key).trialAvailable : false;

    local.set(key, {
      state: to,
      failures,
      openedAt,
      trialAvailable,
    });

    return { key, from: priorLocalState, to, failures };
  }

  function maybeFire(
    from: CircuitState,
    to: CircuitState,
    failures: number,
    model: string | undefined,
    context: CircuitBreakerCallContext | undefined,
  ): void {
    if (from === to) return;
    adapter.onStateChange(from, to, failures, model, context);
  }

  // One-time startup scan: seeds the local cache with any circuit
  // already open elsewhere in Redis, so a fresh process doesn't default
  // an unseen key to closed. Skipped if the client has no scan.
  if (redis.scan) {
    void (async () => {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan!(
          cursor,
          'MATCH',
          `${keyPrefix}*`,
          'COUNT',
          1000,
        );
        cursor = nextCursor;
        if (keys.length === 0) continue;

        for (const key of keys) {
          const raw = await redis.eval(READ_BUCKETS_SCRIPT, 1, key);
          const entry = parseSnapshotResult(raw);
          if (!entry) continue;
          local.set(entry.key, {
            state: entry.state,
            failures: entry.failures,
            openedAt: entry.openedAt,
            trialAvailable: false,
          });
        }
      } while (cursor !== '0');
    })().catch((error: unknown) => reportRejection('snapshot', keyPrefix, error));
  }

  if (options.subscriber) {
    void options.subscriber.subscribe(channel).catch((error: unknown) => {
      reportRejection('subscribe', channel, error);
      // Without a working subscription, pub/sub will never deliver
      // another process's transitions to this one: fall back to the
      // same polling every idle key would get without a subscriber at
      // all, rather than leaving convergence entirely reactive to this
      // process's own calls.
      startPolling();
    });
    options.subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel !== channel) return;

      const parsed = parseTransitionMessage(message);
      if (!parsed) return;

      const priorBucket = local.get(parsed.key);
      const from = priorBucket.state;

      // Mirrors transition()'s own reasoning: pub/sub only ever confirms
      // committed Redis state, it never grants a trial by itself (only
      // this process's own wonProbe result can). If this process is
      // mid-way between winning a trial (its own async transition()
      // hasn't resolved yet) and this message arriving for the same
      // event, preserve whatever's already recorded rather than racing
      // it back to false.
      const bucket: LocalCircuitBucket = {
        state: parsed.state,
        failures: parsed.failures,
        openedAt: parsed.openedAt,
        trialAvailable: parsed.state === 'half-open' ? priorBucket.trialAvailable : false,
      };
      local.set(parsed.key, bucket);

      // No CircuitBreakerCallContext exists for a transition observed
      // via pub/sub, it wasn't triggered by a call this process made.
      // Matches how vern-llm's own wrapOnStateChange treats a missing
      // context: report the event without one, rather than fabricate it.
      maybeFire(
        from,
        parsed.state,
        parsed.failures,
        modelFromKey(parsed.key, keyPrefix, isolateByModel),
        undefined,
      );
    });
  }

  // No subscriber: bound staleness with a periodic re-check instead of
  // leaving convergence purely reactive to this process's own calls.
  // Only re-checks keys this process has actually touched (local.keys()),
  // there's nothing to bound for a key this process has never seen. This
  // is also what actually discovers a cooldown expiring and (possibly)
  // wins the half-open trial when no application call happens to land
  // right after cooldown, since assertClosed itself never guesses that
  // anymore, only ever consumes a trial Redis has already confirmed.
  if (!options.subscriber) startPolling();

  const adapter: CircuitBreakerAdapter = {
    isolateByModel,

    // Reads the same local cache assertClosed gates against, so it's
    // synchronous (getState's required signature) at the cost of the
    // same eventual-consistency characteristic documented on the class:
    // fresh when a subscriber is wired up, otherwise bounded by
    // pollIntervalMs, not a live Redis read on every call.
    getState(model) {
      const key = bucketKey(keyPrefix, isolateByModel, model);
      return local.get(key).state;
    },

    assertClosed(model, context) {
      const key = bucketKey(keyPrefix, isolateByModel, model);
      const bucket = local.get(key);
      const priorState = bucket.state;

      // The only two ways a call is let through: the circuit is closed,
      // or it's half-open AND this process holds a trial Redis has
      // already confirmed it won (never a locally-guessed cooldown
      // check). Consuming the trial here, synchronously, is what stops
      // a second concurrent call on this same process from also being
      // treated as the trial while this one's outcome is still pending.
      let allowed = false;
      if (priorState === 'closed') {
        allowed = true;
      } else if (priorState === 'half-open' && bucket.trialAvailable) {
        bucket.trialAvailable = false;
        allowed = true;
      }

      // Fired regardless of whether this call is allowed through: a
      // call that's about to throw because the circuit still looks open
      // locally is exactly what needs to keep proactively asking Redis
      // whether cooldown has actually elapsed elsewhere, or this key
      // would only ever be confirmed by the background poll/subscriber.
      void transition(model, 'check')
        .then(({ from, to, failures }) => maybeFire(from, to, failures, model, context))
        .catch((error: unknown) => reportRejection('assertClosed transition', key, error));

      if (!allowed) {
        throw new LLMError(
          priorState === 'half-open'
            ? `Circuit half-open, no trial available for ${model ?? 'default'}`
            : `Circuit open for ${model ?? 'default'}`,
          'circuit_open',
        );
      }
    },

    recordSuccess(model, context) {
      void transition(model, 'success')
        .then(({ from, to, failures }) => maybeFire(from, to, failures, model, context))
        .catch((error: unknown) =>
          reportRejection(
            'recordSuccess transition',
            bucketKey(keyPrefix, isolateByModel, model),
            error,
          ),
        );
    },

    recordFailure(model, context) {
      void transition(model, 'failure')
        .then(({ from, to, failures }) => maybeFire(from, to, failures, model, context))
        .catch((error: unknown) =>
          reportRejection(
            'recordFailure transition',
            bucketKey(keyPrefix, isolateByModel, model),
            error,
          ),
        );
    },

    onStateChange: options.onStateChange ?? (() => {}),
  };

  return adapter;
}
