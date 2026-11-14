<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/integrations/redis.png" alt="VernLLM + redis banner"/>
</p>

<p align="center">
  <a href="https://vernllm.dev/docs/integrations/redis">Documentation</a> ·
  <a href="https://github.com/LakBud/vernLLM/tree/main/packages/integrations/vern-llm-redis">Package</a> ·
  <a href="https://www.npmjs.com/package/vern-llm-redis">npm</a>
</p>

<h1 align="center">vern-llm-redis</h1>

<p align="center">Redis backed circuit breaker, rate limiter, retry budget, cache, and usage budget adapters for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a>. Use these when you run more than one process and need shared state instead of each process tracking its own.</p>

<p align="center"><sub>Redis® is a registered trademark of Redis Ltd. This is an unofficial community integration, not affiliated with or endorsed by Redis Ltd.</sub></p>

vern-llm keeps its state in process memory. That is right for one process and wrong for ten: every instance discovers the same outage on its own, ten instances with a limit of 100 requests a minute send 1,000, and each one caches the same answer separately. `vern-llm-redis` backs the circuit breaker, rate limiter, retry budget, cache, and usage budgets with Redis, so every process shares one view. Your calls don't change.

## Installation

```bash
npm i vern-llm-redis
```

`vern-llm` is a peer dependency, so this package shares the copy your app already uses. Bring your own Redis client: ioredis and node-redis (the official `redis` package) are both supported directly. Redis 5 or newer is required.

## Quick start

```ts
import Redis from 'ioredis';
import { VernLLM } from 'vern-llm';
import { redisCache, redisCircuitBreaker, redisRateLimit, redisRetryBudget } from 'vern-llm-redis';
import { fromIoredis, fromIoredisSubscriber } from 'vern-llm-redis/clients';

const redis = new Redis();
const client = fromIoredis(redis);
const subscriber = fromIoredisSubscriber(redis.duplicate());

const llm = new VernLLM({
  circuitBreaker: redisCircuitBreaker(client, { threshold: 5, cooldownMs: 30000, subscriber }),
  rateLimit: redisRateLimit(client, { requestsPerMinute: 100, subscriber }),
  retryBudget: redisRetryBudget(client, { windowMs: 60000, minCalls: 10, retryRatio: 0.1 }),
  cache: redisCache(client),
});
```

Now one process opening a circuit opens it for all of them, and 100 requests a minute means 100 across the fleet.

## What gets shared

| Adapter               | What every process shares                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `redisCircuitBreaker` | Breaker state, pushed over pub/sub, typically within a few ms, with one process winning each half open trial |
| `redisRateLimit`      | Requests, tokens, and concurrency limits, one first come first served queue, and the shrinking after a 429   |
| `redisRetryBudget`    | The share of a target's traffic that may be retries, so a fleet can't retry its way into a provider outage   |
| `redisCache`          | Cached answers, as a drop in for `InMemoryCacheAdapter`                                                      |
| `redisUsageStore`     | [`vern-llm-usage`](https://www.npmjs.com/package/vern-llm-usage) budgets, from `vern-llm-redis/usageStore`   |

## On a Redis outage

Shared state is one more thing that can fail, so each adapter states what it does when Redis is down:

| Adapter         | On a Redis outage                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Circuit breaker | Falls back to core's in-process breaker until Redis answers again. Failed writes are logged and swallowed |
| Retry budget    | Falls back to core's in-process budget, so each process still caps its own retries                        |
| Cache           | Fails open: a cache that errors is treated as a miss                                                      |
| Usage store     | Follows `vern-llm-usage`'s `onStoreError` option: send the call unmetered, or reject it                   |
| Rate limit      | No fail open path. A rejected Redis call fails the LLM call, so a limit is never silently skipped         |

## Usage

### With node-redis

```ts
import { createClient } from 'redis';
import { fromNodeRedis, fromNodeRedisSubscriber } from 'vern-llm-redis/clients';

const raw = await createClient().connect();
const client = fromNodeRedis(raw);

const rawSubscriber = raw.duplicate();
await rawSubscriber.connect();
const subscriber = fromNodeRedisSubscriber(rawSubscriber);
```

### With or without a subscriber

`subscriber` is optional everywhere it appears. With one, breaker transitions and freed concurrency slots reach every process over pub/sub. Without one, the adapters still work correctly and fall back to polling (`pollIntervalMs`), with slightly looser timing. Waits on requests and tokens per minute are always precise: the exact refill time is computed from live bucket state and slept, never polled.

### Details worth knowing

- A custom `TrippingPolicy` or a function `cooldownBackoff` cannot run inside Redis, so they throw at construction instead of silently behaving differently.
- A crashed holder's concurrency slot comes back after `concurrencyLeaseMs`.
- A process joining a retry window already at its ratio starts from an empty copy. `await budget.readState()` at startup loads the live window.
- Every instance sharing the same `keyPrefix` and Redis database coordinates together, so give unrelated services, and each retry budget target, their own prefix.
- The breaker, rate limiter, and retry budget return a `dispose()` method. Call it before closing the Redis client.

### Other Redis clients

The adapters accept anything shaped like `RedisClient` (`get`, `set`, `del`, `eval`) and `RedisSubscriber` (`subscribe`, `on('message', ...)`). Write a small wrapper matching those two interfaces for any other client.

## Documentation

See the [Redis docs](https://vernllm.dev/docs/integrations/redis) for the [circuit breaker](https://vernllm.dev/docs/integrations/redis/features/circuit-breaker), [rate limit](https://vernllm.dev/docs/integrations/redis/features/rate-limit), [retry budget](https://vernllm.dev/docs/integrations/redis/features/retry-budget), [cache](https://vernllm.dev/docs/integrations/redis/features/cache), and [usage store](https://vernllm.dev/docs/integrations/redis/features/usage-store).

## License

MIT
