---
'vern-llm-redis': minor
---

Every adapter validates `keyPrefix`: `redisCircuitBreaker`, `redisRateLimit`, `redisCache` and `redisRetryBudget` throw `LLMError('invalid_params')` at construction for anything but a non-empty string; `null` still means the default. An empty string used to be accepted.

Breaking: an empty `keyPrefix` that worked before now throws. See the Redis migration notes.
