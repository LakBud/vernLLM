---
'vern-llm': major
---

Collapsed `cachedCall`/`cachedLLMCall` into a single public `cachedCall`.

Previously `VernLLM` exposed two caching methods: a generic `cachedCall({ cacheKey, ttl, fn })` that cached whatever `fn` returned with no retry/timeout/circuit-breaker guarantees, and `cachedLLMCall({ cacheKey, ttl, call })` that composed `call()` (retry/timeout/circuit-breaker) with caching. This split didn't match vern-llm's "production-ready resilience for LLM calls" scope, and the generic form was really a general-purpose memoizer that happened to live on the LLM client.

`cachedLLMCall` is renamed to `cachedCall`. The public `cachedCall()` now always composes `call()` internally, so cached results get the same retry/timeout/circuit-breaker behavior as any other LLM call. There is no longer a public way to cache an arbitrary non-LLM function through `VernLLM`. If you were using the old fn-based `cachedCall({ fn })` for general-purpose caching or coalescing unrelated to an LLM call, switch to a dedicated caching library (e.g. `async-cache-dedupe`) at the application level instead.

Type renames to match:

- `CachedLLMCallParams<T>` → `CachedCallParams<T>` (now the public type for `cachedCall()` without tools).
- `CachedLLMToolCallParams<T>` → `CachedToolCallParams<T>` (public type for `cachedCall()` with tools).
- The old generic `CachedCallParams<T>` (the `fn`-based shape) is no longer exported from the package.

See the Migration Notes for details.
