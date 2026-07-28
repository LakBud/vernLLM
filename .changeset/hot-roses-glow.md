---
'vern-llm': minor
---

Coalesce concurrent `cachedCall` misses for the same `cacheKey` into a single `fn()` call.

Previously, every concurrent request for the same `cacheKey` that missed the cache independently
called `fn()`, causing a cache stampede: N simultaneous callers could trigger N calls to the
underlying (possibly expensive) LLM call before any of them had a chance to populate the cache.

Now only the first caller (the "trigger") calls `fn()`; every other concurrent caller for the same
key waits on that same in-flight call and shares its result or failure.

`reserveUsage`/`refundUsage` now receive a `{ coalesced: boolean }` argument, so applications can
decide how coalesced callers are billed: full price, a reduced rate, or not billed at all. This is
backward compatible — existing `() => Promise<void>` implementations don't need to change.

Docs updated in `core/caching.mdx` to describe the coalescing behavior and the new `coalesced` flag.
