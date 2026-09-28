---
'vern-llm-redis': minor
---

Circuit breaker and rate limiter fixes for many processes sharing one Redis, a `vern-llm-redis/clients` subpath, and stricter option validation.

Circuit breaker: `onStateChange` fires once per real change in each process, however many replies, messages or polls carry it, and a stale reply no longer rolls the local state back. A call let through never takes a second trial slot, a burst of rejected calls asks for one slot at a time, `releaseTrial` only gives its slot back, and slots held for an abandoned trial are dropped. A running trial call renews its lease, so a slow trial is never handed over mid call. `cooldownBackoff` uses core's formula, so a cooldown is never shorter than `cooldownMs` unless `maxMs` is. With `isolateByModel`, calls with no model use `keyPrefix` itself, apart from a model named `default`, and the startup scan no longer reads another adapter's keys under a longer prefix.

Rate limiter: `maxQueueSize` counts waiters across every process. The AIMD ceiling lives in its own key, `{keyPrefix:rpm}:aimd`, which survives an idle bucket, starts no higher than `aimd.maxCapacity`, and shrinks at most once a minute across every process, like core.

Both: a Redis failure in `acquire`, `prepare` or `readState` rejects with `LLMError('network')` and code `connection_failed`. Several adapters can share one subscriber, and `dispose()` removes its own listener. Scripts are sent by SHA1 after the first call. `RedisClient` gains optional `evalsha` and `RedisSubscriber` optional `off`, both already on ioredis and now on the node-redis wrappers.

Requires `vern-llm` 3.0.0 as a peer. See the Redis migration notes.

Breaking: `redisRateLimit` validates limits with core's rules and messages, and `redisCircuitBreaker` throws `LLMError('invalid_params')` for every bad option, including a rolling window mistake that used to throw `RangeError` and a `threshold` that is not an integer of at least 1. Calls with no model under `isolateByModel`, and the AIMD ceiling, start fresh once after upgrading.
