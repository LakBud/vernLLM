---
'vern-llm-redis': minor
---

Adds `redisUsageStore`, a Redis backed store for `vern-llm-usage`, so budgets are shared by every process using the same prefix.

```ts
import { usageMiddleware } from 'vern-llm-usage';
import { redisUsageStore } from 'vern-llm-redis/usageStore';
import { fromIoredis } from 'vern-llm-redis/clients';

usageMiddleware({
  prices,
  pricesAsOf,
  attribute,
  budgets,
  store: redisUsageStore(fromIoredis(redis)),
});
```

Each operation is one script, so a reservation holds every scope or none under concurrency, and a hold that is never settled is returned after its ttl, and a call that settles late still records its spend for an hour. Keys share a `{prefix}` hash tag, so a Cluster keeps them in one slot. Also available from `vern-llm-redis/usageStore`.

Nothing existing changes.
