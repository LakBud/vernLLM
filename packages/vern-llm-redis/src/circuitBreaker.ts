import {
  LLMError,
  type CircuitBreakerAdapter,
  type CircuitBreakerCallContext,
  type CircuitBreakerStateChangeHandler,
  type CircuitState,
  type LLMErrorCode,
} from 'vern-llm';

import { bucketKey, modelFromKey } from './internal/circuit-breaker/bucketKey.utils.js';
import { createLocalCircuitCache } from './internal/circuit-breaker/localCache.utils.js';
import {
  READ_BUCKETS_SCRIPT,
  parseSnapshotResult,
} from './internal/circuit-breaker/snapshotScript.js';
import {
  TRANSITION_SCRIPT,
  parseTransitionMessage,
  parseTransitionResult,
} from './internal/circuit-breaker/transitionScript.js';
import { createAdapterLogger, type AdapterLoggerOption } from './internal/logger.utils.js';

import type { RedisClient, RedisSubscriber } from './types.js';

/** Grows the cooldown on each repeat open, with full jitter. Same shape as core's `ExponentialBackoffOptions`. */
export interface RedisCooldownBackoff {
  /** Growth factor applied per repeat open, e.g. 2 doubles each time. */
  multiplier: number;
  /** Upper bound on the computed cooldown, in ms. Default unbounded. */
  maxMs?: number;
}

/** Decides when failures open the circuit. Same shorthand shapes as core's `CircuitBreakerOptions.tripping`. */
export type RedisTrippingOption =
  | { kind: 'consecutive'; threshold: number }
  | { kind: 'rolling'; windowMs: number; minCalls: number; failureRatio: number };

export interface RedisCircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. Default 5. Ignored when `tripping` is set. */
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
  /** Trial calls allowed through per half-open cycle. Default 1, clamped to at least 1. Shared across every process. */
  halfOpenProbes?: number;
  /** Fraction of `halfOpenProbes` that must succeed to close the circuit. Default 1, clamped to `[0, 1]`. */
  halfOpenSuccessRatio?: number;
  /**
   * Grows `cooldownMs` on each repeat open instead of a fixed wait, with
   * full jitter so several instances don't reopen in lockstep. Only the
   * exponential `{ multiplier, maxMs }` form exists here: the growth is
   * computed inside Redis, so core's function form can't run there.
   */
  cooldownBackoff?: RedisCooldownBackoff;
  /**
   * `{ kind: 'consecutive', threshold }` (the default) or `{ kind:
   * 'rolling', windowMs, minCalls, failureRatio }`. The rolling window is
   * shared by every process and split into 10 sub buckets, exactly like
   * core's. A custom `TrippingPolicy` is not supported, it can't run
   * inside Redis.
   */
  tripping?: RedisTrippingOption;
  /**
   * How long a half-open trial slot may stay unreported before Redis
   * hands it to someone else, in ms. Covers a holder that crashed or
   * stopped calling. Set it above your slowest call. Default 60000.
   */
  probeLeaseMs?: number;
  /**
   * How long `VernLLM` waits for this adapter's `prepare` before carrying
   * on with its local state, in ms. Must be a finite number greater than
   * 0. Default 250.
   */
  prepareTimeoutMs?: number;
  /**
   * Where this adapter reports background failures. Defaults to the
   * `logger` of the `VernLLM` instance the adapter is passed to, or the
   * console if it is used on its own. Pass `'silent'` to discard them.
   */
  logger?: AdapterLoggerOption;
}

/** A `CircuitBreakerAdapter` with the extra teardown method `redisCircuitBreaker` adds. */
export interface RedisCircuitBreakerAdapter extends CircuitBreakerAdapter {
  /**
   * Stops the background poll and detaches from the subscriber. Call it
   * before closing the Redis client (shutdown, hot reload, tests),
   * otherwise a leftover timer keeps hitting a closed connection.
   * Idempotent. State already in Redis is untouched.
   */
  dispose(): void;
}

function invalid(message: string): never {
  throw new LLMError(message, 'invalid_params');
}

function assertNonNegativeFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    invalid(`${name} must be a finite number that is not negative (got ${value}).`);
  }
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
): RedisCircuitBreakerAdapter {
  const cooldownMs = options.cooldownMs ?? 30_000;
  const isolateByModel = options.isolateByModel ?? false;
  const keyPrefix = options.keyPrefix ?? 'vernllm:cb';
  const channel = `${keyPrefix}:events`;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const probeLeaseMs = options.probeLeaseMs ?? 60_000;
  const prepareTimeoutMs = options.prepareTimeoutMs ?? 250;

  assertNonNegativeFinite('cooldownMs', cooldownMs);
  assertNonNegativeFinite('pollIntervalMs', pollIntervalMs);
  if (!Number.isFinite(probeLeaseMs) || probeLeaseMs <= 0) {
    invalid(`probeLeaseMs must be a finite number greater than 0 (got ${probeLeaseMs}).`);
  }
  if (!Number.isFinite(prepareTimeoutMs) || prepareTimeoutMs <= 0) {
    invalid(`prepareTimeoutMs must be a finite number greater than 0 (got ${prepareTimeoutMs}).`);
  }

  const rawProbes = options.halfOpenProbes;
  const halfOpenProbes = Number.isFinite(rawProbes) ? Math.max(1, Math.floor(rawProbes!)) : 1;
  const rawRatio = options.halfOpenSuccessRatio;
  const halfOpenSuccessRatio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio!)) : 1;

  const backoff = options.cooldownBackoff;
  if (backoff !== undefined) {
    if (typeof backoff === 'function') {
      invalid(
        'cooldownBackoff as a function is not supported by redisCircuitBreaker, use { multiplier, maxMs }. The growth is computed inside Redis.',
      );
    }
    if (!Number.isFinite(backoff.multiplier) || backoff.multiplier <= 0) {
      invalid(
        `cooldownBackoff.multiplier must be a finite number greater than 0 (got ${backoff.multiplier}).`,
      );
    }
    if (backoff.maxMs !== undefined && (Number.isNaN(backoff.maxMs) || backoff.maxMs <= 0)) {
      invalid(`cooldownBackoff.maxMs must be greater than 0 (got ${backoff.maxMs}).`);
    }
  }

  const tripping: RedisTrippingOption = options.tripping ?? {
    kind: 'consecutive',
    threshold: options.threshold ?? 5,
  };
  if (typeof tripping !== 'object' || tripping === null || !('kind' in tripping)) {
    invalid(
      'tripping must be { kind: "consecutive", threshold } or { kind: "rolling", ... }. A custom TrippingPolicy cannot run inside Redis.',
    );
  }
  if (tripping.kind === 'rolling') {
    if (!Number.isFinite(tripping.windowMs) || tripping.windowMs <= 0) {
      throw new RangeError(
        `tripping.windowMs must be a finite number > 0, got ${tripping.windowMs}`,
      );
    }
    if (!Number.isInteger(tripping.minCalls) || tripping.minCalls < 0) {
      throw new RangeError(
        `tripping.minCalls must be a non-negative integer, got ${tripping.minCalls}`,
      );
    }
    if (
      !Number.isFinite(tripping.failureRatio) ||
      tripping.failureRatio < 0 ||
      tripping.failureRatio > 1
    ) {
      throw new RangeError(
        `tripping.failureRatio must be finite and within [0, 1], got ${tripping.failureRatio}`,
      );
    }
  }
  const threshold = tripping.kind === 'consecutive' ? tripping.threshold : 0;
  const rolling = tripping.kind === 'rolling' ? tripping : undefined;

  const local = createLocalCircuitCache();
  const log = createAdapterLogger('redisCircuitBreaker', options.logger);
  let disposed = false;

  /**
   * The trial slot a specific call won, keyed by the call's own middleware
   * state bag (the same identity core's permits use). Lets a later
   * success, failure or release present the right token, and lets a call
   * that never held a slot be told apart from one that did.
   */
  const permits = new WeakMap<object, { key: string; token: string }>();

  /** When this process last made a call against each key, so an idle process's poll never asks for a trial slot it has no call to spend. */
  const lastDemandAt = new Map<string, number>();

  // Every fire-and-forget Redis call below (transition, subscribe) is
  // reported here instead of becoming an unhandled rejection if it fails.
  // Silent after dispose(): a closed client failing is expected then.
  function reportRejection(operation: string, key: string, error: unknown): void {
    log.failure(operation, error, key);
  }

  // Bounds staleness for a key this process has touched but received no
  // further calls or pub/sub messages for. Started immediately when
  // there's no subscriber, and also as a fallback if a configured
  // subscriber's initial subscribe() never succeeds, since pub/sub can
  // then never take over convergence duty the way it normally would.
  let pollTimer: { unref?: () => void } | undefined;
  function startPolling(): void {
    if (pollTimer || disposed || pollIntervalMs <= 0) return;

    const timer = setInterval(() => {
      const now = Date.now();

      for (const key of [...local.keys()]) {
        const model = modelFromKey(key, keyPrefix, isolateByModel);
        // Only a process that has recently been calling may win a trial
        // slot from a poll. An idle one would hold it with nothing to
        // spend it on, until its lease ran out.
        const recentDemand = now - (lastDemandAt.get(key) ?? 0) < pollIntervalMs * 2;

        void transition(model, 'check', { grant: recentDemand })
          .then(({ from, to, failures }) => maybeFire(from, to, failures, model, undefined))
          .catch((error: unknown) => reportRejection('poll transition', key, error));
      }
    }, pollIntervalMs) as unknown as { unref?: () => void };

    // Prevents this background poll from keeping a short-lived process
    // (a script, a test, a serverless invocation) alive on its own.
    // Not available in every environment (e.g. browsers), guarded.
    timer.unref?.();
    pollTimer = timer;
  }

  interface TransitionOptions {
    /** The token this call's outcome presents. '' means none, '*' means "no call context, always counts". */
    token?: string;
    code?: string;
    /** Whether a 'check' may win a half-open trial slot. Default true. */
    grant?: boolean;
  }

  async function transition(
    model: string | undefined,
    outcome: 'check' | 'success' | 'failure' | 'release' | 'open' | 'close',
    opts: TransitionOptions = {},
  ): Promise<{ key: string; from: CircuitState; to: CircuitState; failures: number }> {
    const key = bucketKey(keyPrefix, isolateByModel, model);

    // Captured before local.set below overwrites it. This process's own
    // prior local state, not Redis's `from`, is what maybeFire compares
    // `to` against: if a pub/sub message (or an earlier call) already
    // brought this process's local cache to `to`, that's a no-op from
    // this process's perspective and must not fire a duplicate callback,
    // even though Redis's own bucket genuinely moved through `from`.
    const priorLocalState = local.get(key).state;

    const {
      to,
      failures,
      wonProbe,
      openedAt,
      probeToken,
      breakdown,
      serverNow,
      cooldownMs: reportedCooldownMs,
      grantAt,
      slots,
    } = parseTransitionResult(
      await redis.eval(
        TRANSITION_SCRIPT,
        1,
        key,
        outcome,
        channel,
        threshold,
        cooldownMs,
        probeLeaseMs,
        opts.token ?? '',
        opts.grant === false ? '0' : '1',
        halfOpenProbes,
        halfOpenSuccessRatio,
        backoff?.multiplier ?? 0,
        backoff?.maxMs ?? 0,
        Math.random(),
        rolling?.windowMs ?? 0,
        rolling?.minCalls ?? 0,
        rolling?.failureRatio ?? 0,
        opts.code ?? '',
      ),
    );

    // Re-read the live bucket now, right before writing, not a snapshot
    // captured before the await above. local.set() below replaces the map
    // entry wholesale rather than mutating it in place, so another call's
    // write could have landed while this one was in flight; reading fresh
    // here means an in-flight call with a stale snapshot can never
    // clobber a newer grant with an old false.
    const prior = local.get(key);
    const inHalfOpen = to === 'half-open';

    local.set(key, {
      state: to,
      failures,
      openedAt,
      trialsHeld: !inHalfOpen
        ? 0
        : wonProbe
          ? // Slots of the same trial add up. A win under a new epoch means the
            // old trial was abandoned, so the slots held for it are dead.
            (prior.trialToken === probeToken ? prior.trialsHeld : 0) + 1
          : prior.trialsHeld,
      trialToken: wonProbe ? probeToken : inHalfOpen ? prior.trialToken : '',
      breakdown,
      serverOffset: serverNow - Date.now(),
      cooldownMs: reportedCooldownMs,
      slots,
      grantAt,
    });

    return { key, from: priorLocalState, to, failures };
  }

  /**
   * Writes a state observed in Redis (a pub/sub message, or a live read)
   * into the local cache and reports the transition.
   *
   * Mirrors transition()'s own reasoning: an observation only ever confirms
   * committed Redis state, it never grants a trial by itself (only this
   * process's own wonProbe result can). If this process is mid way between
   * winning a trial (its own async transition() hasn't resolved yet) and
   * an observation arriving for the same event, whatever is already
   * recorded is preserved instead of being raced back to false. Timing
   * fields are kept as they were when the observation carries none.
   */
  function applyObserved(
    key: string,
    observed: { state: CircuitState; failures: number; openedAt: number },
    timing?: { serverNow: number; cooldownMs: number; slots: number; grantAt: number },
  ): void {
    const prior = local.get(key);
    const halfOpen = observed.state === 'half-open';

    local.set(key, {
      state: observed.state,
      failures: observed.failures,
      openedAt: observed.openedAt,
      trialsHeld: halfOpen ? prior.trialsHeld : 0,
      trialToken: halfOpen ? prior.trialToken : '',
      breakdown: prior.breakdown,
      serverOffset: timing ? timing.serverNow - Date.now() : prior.serverOffset,
      cooldownMs: timing?.cooldownMs ?? prior.cooldownMs,
      slots: timing?.slots ?? prior.slots,
      grantAt: timing?.grantAt ?? prior.grantAt,
    });

    // Matches how vern-llm's own wrapOnStateChange treats a missing
    // context: report the event without one, rather than fabricate it.
    maybeFire(
      prior.state,
      observed.state,
      observed.failures,
      modelFromKey(key, keyPrefix, isolateByModel),
      undefined,
    );
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

  /** Runs `transition` fire-and-forget, firing onStateChange and reporting any rejection. */
  function run(
    operation: string,
    model: string | undefined,
    outcome: Parameters<typeof transition>[1],
    context: CircuitBreakerCallContext | undefined,
    opts?: TransitionOptions,
  ): Promise<void> {
    return transition(model, outcome, opts)
      .then(({ from, to, failures }) => maybeFire(from, to, failures, model, context))
      .catch((error: unknown) =>
        reportRejection(operation, bucketKey(keyPrefix, isolateByModel, model), error),
      );
  }

  /** The token a call's outcome presents: its own permit's, none if it held no slot, or "always counts" when there's no call context at all. */
  function takePermitToken(key: string, context: CircuitBreakerCallContext | undefined): string {
    if (!context) return '*';

    const permit = permits.get(context.state);
    if (!permit || permit.key !== key) return '';

    permits.delete(context.state);
    return permit.token;
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
          if (disposed) return;

          const raw = await redis.eval(READ_BUCKETS_SCRIPT, 1, key);
          const entry = parseSnapshotResult(raw);
          if (!entry) continue;

          // This scan is slow and this process may have already heard
          // about the key from a pub/sub message or its own call. That is
          // newer than a snapshot read earlier, so never overwrite it.
          if (!local.isPristine(entry.key)) continue;

          local.set(entry.key, {
            state: entry.state,
            failures: entry.failures,
            openedAt: entry.openedAt,
            trialsHeld: 0,
            trialToken: '',
            breakdown: {},
            // A snapshot carries no clock or cooldown, so a seeded open
            // circuit reads as "cooldown may be over" until `prepare` asks.
            serverOffset: 0,
            cooldownMs: 0,
            slots: 0,
            grantAt: 0,
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
      if (disposed || receivedChannel !== channel) return;

      const parsed = parseTransitionMessage(message);
      if (!parsed) return;

      // No CircuitBreakerCallContext exists for a transition observed
      // via pub/sub, it wasn't triggered by a call this process made.
      applyObserved(parsed.key, parsed, parsed);
    });
  }

  // No subscriber: bound staleness with a periodic re-check instead of
  // leaving convergence purely reactive to this process's own calls.
  // Only re-checks keys this process has actually touched (local.keys()),
  // there's nothing to bound for a key this process has never seen.
  if (!options.subscriber) startPolling();

  /** Refreshes already running per key, so a burst of calls shares one Redis round trip. */
  const refreshing = new Map<string, { promise: Promise<void>; startedAt: number }>();

  /**
   * Whether asking Redis could change what `assertClosed` decides. It
   * judges from what the last report said, plus the clock offset it also
   * carried, so the common cases cost nothing:
   *
   * a key never seen, so it may be open elsewhere: yes.
   * closed: no, the poll and pub/sub keep it fresh.
   * open: only once its cooldown has probably run out, until then every
   * call is going to be rejected anyway and a round trip would only slow
   * the rejection down.
   * half-open holding a slot: no, this call can use it.
   * half-open without one: only if a slot is known to be free, or the
   * holder's lease has probably lapsed and the trial can be taken over.
   */
  function needsRefresh(key: string): boolean {
    if (local.isPristine(key)) return true;

    const bucket = local.get(key);
    const serverNow = Date.now() + bucket.serverOffset;

    if (bucket.state === 'open') return serverNow - bucket.openedAt >= bucket.cooldownMs;
    if (bucket.state === 'half-open' && bucket.trialsHeld === 0) {
      return bucket.slots > 0 || (bucket.grantAt > 0 && serverNow - bucket.grantAt >= probeLeaseMs);
    }
    return false;
  }

  const adapter: RedisCircuitBreakerAdapter = {
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

    getFailureBreakdown(model) {
      const key = bucketKey(keyPrefix, isolateByModel, model);
      return { ...local.get(key).breakdown } as Partial<Record<LLMErrorCode | 'unknown', number>>;
    },

    assertClosed(model, context) {
      const key = bucketKey(keyPrefix, isolateByModel, model);
      const bucket = local.get(key);
      const priorState = bucket.state;
      lastDemandAt.set(key, Date.now());

      // The only two ways a call is let through: the circuit is closed,
      // or it's half-open AND this process holds a trial Redis has
      // already confirmed it won (never a locally-guessed cooldown
      // check). Consuming the trial here, synchronously, is what stops
      // a second concurrent call on this same process from also being
      // treated as the trial while this one's outcome is still pending.
      let allowed = false;
      if (priorState === 'closed') {
        allowed = true;
      } else if (priorState === 'half-open' && bucket.trialsHeld > 0) {
        bucket.trialsHeld -= 1;
        allowed = true;
        if (context) permits.set(context.state, { key, token: bucket.trialToken });
      }

      // Fired regardless of whether this call is allowed through: a
      // call that's about to throw because the circuit still looks open
      // locally is exactly what needs to keep proactively asking Redis
      // whether cooldown has actually elapsed elsewhere, or this key
      // would only ever be confirmed by the background poll/subscriber.
      void run('assertClosed transition', model, 'check', context);

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
      const key = bucketKey(keyPrefix, isolateByModel, model);
      void run('recordSuccess transition', model, 'success', context, {
        token: takePermitToken(key, context),
      });
    },

    recordFailure(model, context, code) {
      const key = bucketKey(keyPrefix, isolateByModel, model);
      void run('recordFailure transition', model, 'failure', context, {
        token: takePermitToken(key, context),
        code,
      });
    },

    releaseTrial(model, context) {
      if (!context) return;

      const key = bucketKey(keyPrefix, isolateByModel, model);
      const permit = permits.get(context.state);
      if (!permit || permit.key !== key) return;
      permits.delete(context.state);

      // Gives the slot back in Redis, then immediately asks for one again:
      // this process just proved it has demand, and without the re-check
      // the next call would be rejected once before it could win it.
      void run('releaseTrial transition', model, 'release', context, {
        token: permit.token,
      }).then(() => run('releaseTrial check', model, 'check', context));
    },

    open(model, context) {
      void run('open transition', model, 'open', context);
    },

    close(model, context) {
      void run('close transition', model, 'close', context);
    },

    prepareTimeoutMs,

    /**
     * Refreshes the local copy from Redis when that could change what
     * `assertClosed` is about to decide, so a key never seen, or the first
     * call after a cooldown, is judged on real state instead of a guess.
     * Rejects if Redis does: `VernLLM` treats that as fail open.
     */
    prepare(model) {
      if (disposed) return Promise.resolve();

      const key = bucketKey(keyPrefix, isolateByModel, model);
      lastDemandAt.set(key, Date.now());
      if (!needsRefresh(key)) return Promise.resolve();

      const running = refreshing.get(key);
      if (running) {
        // A refresh that has already outlived the timeout means Redis is
        // slow right now. Joining it again would only make every call pay
        // that delay, so calls go ahead on local state until it settles.
        return Date.now() - running.startedAt >= prepareTimeoutMs
          ? Promise.resolve()
          : running.promise;
      }

      const refresh = (async () => {
        try {
          const { from, to, failures } = await transition(model, 'check');
          maybeFire(from, to, failures, model, undefined);
        } finally {
          refreshing.delete(key);
        }
      })();
      refreshing.set(key, { promise: refresh, startedAt: Date.now() });
      return refresh;
    },

    /** The state in Redis right now, not this process's local copy. Also refreshes that copy. */
    async readState(model) {
      const key = bucketKey(keyPrefix, isolateByModel, model);
      const entry = parseSnapshotResult(await redis.eval(READ_BUCKETS_SCRIPT, 1, key));
      const observed = entry ?? { state: 'closed' as const, failures: 0, openedAt: 0 };

      applyObserved(key, observed);
      return observed.state;
    },

    onStateChange: options.onStateChange ?? (() => {}),

    setLogger(logger) {
      log.adopt(logger);
    },

    dispose() {
      disposed = true;
      log.mute();

      if (pollTimer) {
        clearInterval(pollTimer as unknown as ReturnType<typeof setInterval>);
        pollTimer = undefined;
      }
      if (options.subscriber?.unsubscribe) {
        void Promise.resolve(options.subscriber.unsubscribe(channel)).catch(() => {});
      }
    },
  };

  return adapter;
}
