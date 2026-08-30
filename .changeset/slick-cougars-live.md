---
'vern-llm': minor
---

Add `eviction` to `InMemoryCacheAdapter`, choosing between `'fifo'` (default) and `'lru'` once
`maxSize` is exceeded.

Previously, `InMemoryCacheAdapter` always evicted the oldest inserted entry, regardless of how
recently it was read. A key that's read constantly but written once still aged out on schedule
alongside keys nobody had touched since.

```ts
const cache = new InMemoryCacheAdapter(1000, 'lru');
```

`VernLLMOptions.cache` also gains a plain config shorthand, so the built-in adapter no longer
needs an import or a `new`:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  cache: { maxSize: 1000, eviction: 'lru' },
});
```

Passing a `CacheAdapter` directly still works exactly as before, `cache` accepts either shape and
resolves structurally. Omitting `cache` entirely, or passing `new InMemoryCacheAdapter()` (no
second argument), keeps today's exact default: fifo eviction, `maxSize` 1000.

There's no custom eviction extension point beyond `'fifo'`/`'lru'`. Anything past those two is a
different cache backend through `CacheAdapter` (a real Redis or Upstash instance, for example),
not a third in-process algorithm.

See [Eviction](/docs/core/caching#eviction) for details.
