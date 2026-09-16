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
   * Without a subscriber, a transition caused by another process is
   * otherwise only picked up by this process's own next recorded
   * outcome for that same key, which can be arbitrarily far away for an
   * idle key. This background poll bounds that: every pollIntervalMs,
   * every key this process has touched is re-checked against Redis.
   * Default 5000. Set 0 to disable. Ignored entirely once a subscriber
   * is supplied, pub/sub already keeps the cache current without polling.
   */
  pollIntervalMs?: number;
}

/**
 * A CircuitBreakerAdapter backed by Redis, so circuit state is shared
 * across every process talking to the same key.
 *
 * assertClosed must throw synchronously (that is its signature in
 * vern-llm), but Redis is async. This adapter resolves that with a
 * local cache per key: assertClosed gates against the local cache
 * immediately. That cache is kept fresh two ways, in order of
 * preference. With a `subscriber` connection supplied, every real
 * transition anywhere is pushed to every process via pub/sub, typically
 * landing within a few ms. Without one, a background poll (see
 * `pollIntervalMs`) re-checks every key this process has touched on a
 * fixed interval, bounding staleness instead of leaving it purely
 * reactive to this process's own calls.
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
  const pollIntervalMs = options.subscriber ? 0 : (options.pollIntervalMs ?? 5_000);

  const local = createLocalCircuitCache();

  async function transition(
    model: string | undefined,
    outcome: 'check' | 'success' | 'failure',
  ): Promise<{ key: string; from: CircuitState; to: CircuitState; failures: number }> {
    const key = bucketKey(keyPrefix, isolateByModel, model);

    const { from, to, failures } = parseTransitionResult(
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

    local.set(key, { state: to, failures, openedAt: to === 'open' ? Date.now() : 0 });

    return { key, from, to, failures };
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

  if (options.subscriber) {
    void options.subscriber.subscribe(channel);
    options.subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel !== channel) return;

      const parsed = parseTransitionMessage(message);
      if (!parsed) return;

      const from = local.get(parsed.key).state;
      const bucket: LocalCircuitBucket = {
        state: parsed.state,
        failures: parsed.failures,
        openedAt: parsed.openedAt,
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
  // there's nothing to bound for a key this process has never seen.
  if (!options.subscriber && pollIntervalMs > 0) {
    const timer = setInterval(() => {
      for (const key of [...local.keys()]) {
        const model = modelFromKey(key, keyPrefix, isolateByModel);
        void transition(model, 'check').then(({ from, to, failures }) =>
          maybeFire(from, to, failures, model, undefined),
        );
      }
    }, pollIntervalMs) as unknown as { unref?: () => void };

    // Prevents this background poll from keeping a short-lived process
    // (a script, a test, a serverless invocation) alive on its own.
    // Not available in every environment (e.g. browsers), guarded.
    timer.unref?.();
  }

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

      // Locally known open past its cooldown: allow one trial through
      // and reflect the transition locally now, matching what the next
      // recorded outcome (or the next pub/sub message) will confirm.
      if (bucket.state === 'open' && Date.now() - bucket.openedAt >= cooldownMs) {
        maybeFire('open', 'half-open', bucket.failures, model, context);
        bucket.state = 'half-open';
      }

      if (bucket.state === 'open') {
        throw new LLMError(`Circuit open for ${model ?? 'default'}`, 'circuit_open');
      }

      // Without a subscriber, this is the only way a transition caused
      // by another process is ever picked up. With one, this is a cheap
      // extra confirmation, pub/sub already keeps the cache current.
      void transition(model, 'check').then(({ from, to, failures }) =>
        maybeFire(from, to, failures, model, context),
      );
    },

    recordSuccess(model, context) {
      void transition(model, 'success').then(({ from, to, failures }) =>
        maybeFire(from, to, failures, model, context),
      );
    },

    recordFailure(model, context) {
      void transition(model, 'failure').then(({ from, to, failures }) =>
        maybeFire(from, to, failures, model, context),
      );
    },

    onStateChange: options.onStateChange ?? (() => {}),
  };

  return adapter;
}
