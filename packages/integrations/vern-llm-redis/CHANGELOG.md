# vern-llm-redis

## 0.4.0

### Minor Changes

- a56208b: Add `redisRetryBudget`, a retry budget shared by every process using the same key, also exported from `vern-llm-redis/retryBudget`.

  It takes core's `windowMs`, `minCalls` and `retryRatio`, plus `keyPrefix` (default `vernllm:rb`) and `logger`. Each attempt runs one script that counts it and returns the window's totals, so `assertAvailable` stays synchronous and never waits on Redis. The window is 10 sub buckets in one hash at `keyPrefix:window`, so it never shares a key with another adapter on the same prefix. It runs on the Redis clock, works on Redis Cluster, and expires after twice `windowMs` of no traffic. `readState()` reads the live window and powers `llm.readRetryBudgetState()`.

  On a Redis outage the budget falls back to core's in-process `RetryBudget` over this process's own attempts, while a Redis call has failed or no reply has landed for `windowMs`, and switches back on the next reply. A failed record is logged. `readState` rejects with `LLMError('network')` and code `connection_failed`. Bad options throw `LLMError('invalid_params')`.

  Requires the `vern-llm` release with `RetryBudgetAdapter`.

- daa6494: `redisCircuitBreaker` keeps working while Redis is unreachable. The first Redis call that fails, or is still pending after `prepareTimeoutMs`, switches the process to core's in-process `CircuitBreaker`, built from the same options and starting closed, so a circuit can still open from this process's own failures. Its changes fire `onStateChange` and the `circuit_state` event. Calls keep going to Redis without claiming a trial slot, and the first one that answers switches back to the shared state. A circuit Redis last reported open or half-open stays rejected until a reply lands, so a stall never admits calls Redis had held back.

  Before, a failed transition left the local copy as it was, so a closed circuit could never open during an outage.

- a56208b: Every adapter validates `keyPrefix`: `redisCircuitBreaker`, `redisRateLimit`, `redisCache` and `redisRetryBudget` throw `LLMError('invalid_params')` at construction for anything but a non-empty string; `null` still means the default. An empty string used to be accepted.

  Breaking: an empty `keyPrefix` that worked before now throws. See the Redis migration notes.

- 149e69a: Adds `redisUsageStore`, a Redis backed store for `vern-llm-usage`, so budgets are shared by every process using the same prefix.

  ```ts
  import { usageMiddleware } from 'vern-llm-usage';
  import { redisUsageStore } from 'vern-llm-redis/usageStore';
  import { fromIoredis } from 'vern-llm-redis/clients';

  usageMiddleware({
    prices,
    pricesAsOf,
    attribute,
    budgets,
    store: redisUsageStore(fromIoredis(redis)),
  });
  ```

  Each operation is one script, so a reservation holds every scope or none under concurrency, and a hold that is never settled is returned after its ttl, and a call that settles late still records its spend for an hour. Keys share a `{prefix}` hash tag, so a Cluster keeps them in one slot. Also available from `vern-llm-redis/usageStore`.

  Nothing existing changes.

### Patch Changes

- 627b2a3: Fix a race on a cold script cache that could count a retry budget's attempts twice.

  The first call of each Lua script waited for its SHA1 digest before returning, so on a cold cache a reply could reach the adapter after a later reply. A `redisRetryBudget` then added its in flight attempts on top of a `readState` that already included them, and `assertAvailable` could throw before `minCalls` was reached. Replies now return as soon as Redis answers, in the order Redis ran them, and the digest is only awaited by the next call. This applies to every Redis adapter, since they share the script cache.

- 2c1af98: `fromNodeRedis` works with node-redis 5 and later, which only accept a string `SCAN` cursor.

  The adapter sent a number, so with node-redis 6 the circuit breaker's startup scan failed with a logged `snapshot failed` warning, and a new process never learned about circuits already open elsewhere. It now sends the string cursor, which node-redis 4 also accepts, and turns the reply cursor into a string. `NodeRedisLike.scan` accepts both the node-redis 4 and the node-redis 5 and later shapes, so a client of either version type checks.

  Passing a node-redis client to `fromNodeRedis` keeps compiling and behaving the same on node-redis 4. On node-redis 5 and later, startup seeding now works instead of logging a warning. Type level only: `NodeRedisLike.scan` is now a union of two function types, so code that calls `scan` directly on a `NodeRedisLike` value needs a cast.

- Updated dependencies: vern-llm@3.1.0

## 0.3.0

### Minor Changes

- 76331c9: Circuit breaker and rate limiter fixes for many processes sharing one Redis, a `vern-llm-redis/clients` subpath, and stricter option validation.

  Circuit breaker: `onStateChange` fires once per real change in each process, however many replies, messages or polls carry it, and a stale reply no longer rolls the local state back. A call let through never takes a second trial slot, a burst of rejected calls asks for one slot at a time, `releaseTrial` only gives its slot back, and slots held for an abandoned trial are dropped. A running trial call renews its lease, so a slow trial is never handed over mid call. `cooldownBackoff` uses core's formula, so a cooldown is never shorter than `cooldownMs` unless `maxMs` is. With `isolateByModel`, calls with no model use `keyPrefix` itself, apart from a model named `default`, and the startup scan no longer reads another adapter's keys under a longer prefix.

  Rate limiter: `maxQueueSize` counts waiters across every process. The AIMD ceiling lives in its own key, `{keyPrefix:rpm}:aimd`, which survives an idle bucket, starts no higher than `aimd.maxCapacity`, and shrinks at most once a minute across every process, like core.

  Both: a Redis failure in `acquire`, `prepare` or `readState` rejects with `LLMError('network')` and code `connection_failed`. Several adapters can share one subscriber, and `dispose()` removes its own listener. Scripts are sent by SHA1 after the first call. `RedisClient` gains optional `evalsha` and `RedisSubscriber` optional `off`, both already on ioredis and now on the node-redis wrappers.

  Requires `vern-llm` 3.0.0 as a peer. See the Redis migration notes.

  Breaking: `fromIoredis`, `fromIoredisSubscriber`, `fromNodeRedis` and `fromNodeRedisSubscriber` are exported from `vern-llm-redis/clients`, no longer from the root entry. `redisRateLimit` validates limits with core's rules and messages, and `redisCircuitBreaker` throws `LLMError('invalid_params')` for every bad option, including a rolling window mistake that used to throw `RangeError` and a `threshold` that is not an integer of at least 1. Calls with no model under `isolateByModel`, and the AIMD ceiling, start fresh once after upgrading.

### Patch Changes

- Updated dependencies: vern-llm@3.0.0

## 0.2.1

### Patch Changes

- 34dc0c0: Fix a missed wake in the rate limiter. A release published before the subscriber's `SUBSCRIBE` was confirmed was lost, so a waiter only woke on the next poll. `acquire` now waits for the subscription first, bounded by the poll interval.
- Updated dependencies [805908b]
  - vern-llm@2.9.1

## 0.2.0

### Minor Changes

- c1725b0: Add `vern-llm-redis`, Redis backed adapters for `vern-llm`: `redisCircuitBreaker`, `redisRateLimit`, and `redisCache`, implementing `vern-llm`'s existing `CircuitBreakerAdapter`, `RateLimiterAdapter`, and `CacheAdapter` interfaces so circuit state, rate limit budgets, and cached responses are shared across every process talking to the same Redis instance rather than tracked per process.

  ```ts
  import Redis from 'ioredis';
  import { VernLLM } from 'vern-llm';
  import { redisCircuitBreaker, redisRateLimit, redisCache, fromIoredis } from 'vern-llm-redis';

  const client = fromIoredis(new Redis());

  const llm = new VernLLM({
    circuitBreaker: redisCircuitBreaker(client, { threshold: 5, cooldownMs: 30000 }),
    rateLimit: redisRateLimit(client, { requestsPerMinute: 100 }),
    cache: redisCache(client),
  });
  ```

  Both `ioredis` and node-redis (the official `redis` package) are supported through `fromIoredis`/`fromNodeRedis` client wrappers. `vern-llm` is a peer dependency; nothing about `vern-llm`'s own behavior or exports changes.

  New package, first release.

### Patch Changes

- Updated dependencies [b6b1400]
- Updated dependencies [2de140f]
- Updated dependencies [7277ee1]
- Updated dependencies [0187299]
- Updated dependencies [00b1c0f]
- Updated dependencies [abac0fb]
  - vern-llm@2.9.0
