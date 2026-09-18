---
'vern-llm-redis': minor
---

Add `vern-llm-redis`, Redis backed adapters for `vern-llm`: `redisCircuitBreaker`, `redisRateLimit`, and `redisCache`, implementing `vern-llm`'s existing `CircuitBreakerAdapter`, `RateLimiterAdapter`, and `CacheAdapter` interfaces so circuit state, rate limit budgets, and cached responses are shared across every process talking to the same Redis instance rather than tracked per process.

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
