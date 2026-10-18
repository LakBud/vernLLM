---
'vern-llm-redis': minor
---

Add `redisRetryBudget`, a retry budget shared by every process using the same key, also exported from `vern-llm-redis/retryBudget`.

It takes core's `windowMs`, `minCalls` and `retryRatio`, plus `keyPrefix` (default `vernllm:rb`) and `logger`. Each attempt runs one script that counts it and returns the window's totals, so `assertAvailable` stays synchronous and never waits on Redis. The window is 10 sub buckets in one hash at `keyPrefix:window`, so it never shares a key with another adapter on the same prefix. It runs on the Redis clock, works on Redis Cluster, and expires after twice `windowMs` of no traffic. `readState()` reads the live window and powers `llm.readRetryBudgetState()`.

On a Redis outage the budget falls back to core's in-process `RetryBudget` over this process's own attempts, while a Redis call has failed or no reply has landed for `windowMs`, and switches back on the next reply. A failed record is logged. `readState` rejects with `LLMError('network')` and code `connection_failed`. Bad options throw `LLMError('invalid_params')`.

Requires the `vern-llm` release with `RetryBudgetAdapter`.
