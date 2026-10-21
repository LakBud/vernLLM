---
'vern-llm-redis': patch
---

Fix a race on a cold script cache that could count a retry budget's attempts twice.

The first call of each Lua script waited for its SHA1 digest before returning, so on a cold cache a reply could reach the adapter after a later reply. A `redisRetryBudget` then added its in flight attempts on top of a `readState` that already included them, and `assertAvailable` could throw before `minCalls` was reached. Replies now return as soon as Redis answers, in the order Redis ran them, and the digest is only awaited by the next call. This applies to every Redis adapter, since they share the script cache.
