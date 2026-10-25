---
'vern-llm': minor
---

A `wrap` can run everything inside it again as a separate chain with `next.again()`, at the same time as the first chain or after it.

```ts
const rerunOnce: VernLLMMiddleware = {
  name: 'rerun-once',
  reruns: true,
  wrap: async (request, next) => {
    const first = await next();
    if (!next.again || isAcceptable(first.value)) return first;
    return next.again({ targets: ['fallback'] });
  },
};
```

Set `reruns: true` on the middleware entry to get it. When the `wrap` settles, every chain whose result it didn't return is cancelled, so return a chain's result unchanged; on a throw, every chain is cancelled. Targets narrow as with `next({ targets })`. Each chain reserves and refunds with `reserveUsage` and `refundUsage` like a call of its own. At most 4 per call, after which `next.again` is `undefined`, as it is for entries without `reruns`. In `cachedCall()`, a rerun is a fresh call for this caller that never reads the cache or joins a shared call, reserves as a full spend, and writes its answer to the cache.

Contexts, events and `CallMeta` carry an optional `chain`, absent for the main chain. Middleware inside a rerunning `wrap` get one `ctx.own` per chain; middleware outside it keep one `ctx.own` per call, in every hook. `WrapNext` and `WrapNextOptions` are exported.

Existing code keeps compiling and behaving the same at runtime: entries without `reruns` run exactly as before, and every new field and `next.again` is optional.
