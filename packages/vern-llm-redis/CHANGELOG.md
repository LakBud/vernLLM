# vern-llm-redis

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
