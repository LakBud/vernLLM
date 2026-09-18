<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/integrations/redis.png" alt="VernLLM + redis banner"/>
</p>

<h1 align="center">vern-llm-redis</h1>

<p align="center">Redis backed circuit breaker, rate limiter, and cache adapters for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a>. Use these when you run more than one process and need shared state instead of each process tracking its own. Docs: <a href="https://vernllm.dev/docs/integrations/redis">vernllm.dev</a></p>

<p align="center"><sub>Redis® is a registered trademark of Redis Ltd. This is an unofficial community integration, not affiliated with or endorsed by Redis Ltd.</sub></p>

## Install

```
npm i vern-llm-redis
```

`vern-llm` is a runtime dependency. Bring your own Redis client, ioredis and node-redis (the official "redis" package) are both supported directly.

## Usage with ioredis

```ts
import Redis from 'ioredis';
import { VernLLM } from 'vern-llm';
import {
  redisCircuitBreaker,
  redisRateLimit,
  redisCache,
  fromIoredis,
  fromIoredisSubscriber,
} from 'vern-llm-redis';

const redis = new Redis();
const client = fromIoredis(redis);
const subscriber = fromIoredisSubscriber(redis.duplicate());

const llm = new VernLLM({
  circuitBreaker: redisCircuitBreaker(client, { threshold: 5, cooldownMs: 30000, subscriber }),
  rateLimit: redisRateLimit(client, {
    requestsPerMinute: 100,
    aimd: { increaseBy: 5, decreaseFactor: 0.5, minCapacity: 10, maxCapacity: 200 },
    subscriber,
  }),
  cache: redisCache(client),
});
```

## Usage with node-redis

```ts
import { createClient } from 'redis';
import { VernLLM } from 'vern-llm';
import {
  redisCircuitBreaker,
  redisRateLimit,
  redisCache,
  fromNodeRedis,
  fromNodeRedisSubscriber,
} from 'vern-llm-redis';

const raw = await createClient().connect();
const client = fromNodeRedis(raw);

const rawSubscriber = raw.duplicate();
await rawSubscriber.connect();
const subscriber = fromNodeRedisSubscriber(rawSubscriber);

const llm = new VernLLM({
  circuitBreaker: redisCircuitBreaker(client, { subscriber }),
  rateLimit: redisRateLimit(client, { requestsPerMinute: 100, subscriber }),
  cache: redisCache(client),
});
```

`subscriber` is optional everywhere it appears. Without one, both adapters still work correctly, just with slightly looser timing, see below.

## Adapters

**redisCircuitBreaker** gates each call against Redis backed state. `assertClosed` throws synchronously off a local cache. With `subscriber`, every real transition anywhere is pushed to every process over pub/sub, typically within a few ms. Without one, a background poll (`pollIntervalMs`, default 5000) re-checks every key this process has touched, bounding staleness instead of leaving it purely reactive to this process's own calls.

**redisRateLimit** enforces requests per minute, tokens per minute, and concurrency across processes, including a shared AIMD ceiling when `aimd` is set. Requests/min and tokens/min waits are always precise: the exact refill time is computed from live bucket state and slept, never polled. Concurrency waits, which only clear via an external release, wake on that release's pub/sub notification when `subscriber` is set; without one they fall back to polling every `pollIntervalMs` (default 250), since nothing else can know when a slot freed.

**redisCache** matches `vern-llm`'s own `CacheAdapter` shape. Drop it in anywhere `InMemoryCacheAdapter` is used today.

## Other Redis clients

Both adapters accept anything shaped like `RedisClient` (`get`, `set`, `del`, `eval`) and `RedisSubscriber` (`subscribe`, `on('message', ...)`). Write a small wrapper matching those two interfaces for any other client, the same pattern `fromIoredis`/`fromNodeRedis` use.
