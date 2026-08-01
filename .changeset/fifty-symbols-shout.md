---
'vern-llm': minor
---

Added an extensible cache adapter framework that allows applications to customize and compose caching strategies.

Added `resolveKey` support to `CacheAdapter` for canonicalizing cache keys before lookups and in-flight request coalescing.
Cache adapters can now transform equivalent but differently formatted keys into a shared canonical key, allowing requests such as normalized, semantic, or fuzzy matches to reuse the same cached response and active generation.
This enables advanced cache matching strategies without changing VernLLM's core caching flow, while keeping existing adapters fully compatible through the optional `resolveKey` method.

Included built-in adapters:

- `InMemoryCacheAdapter` for zero-dependency local caching with TTL support and bounded memory usage.
- `NormalizedCacheAdapter` for normalizing cache keys to avoid duplicate entries caused by formatting differences.
- `TieredCacheAdapter` for multi-level caching with fast local L1 caches and shared L2 caches, including promotion of L2 hits back into L1.

This enables support for advanced caching architectures such as local + distributed caches, custom cache providers (Redis, Upstash, databases, etc.), and future semantic or fuzzy cache implementations without changing VernLLM's core execution flow.

Docs has been update within guides to showcase these new adapters.
Tests has been added on `cachedCall.unit.test.ts` and `index.exports.unit.test.ts`
