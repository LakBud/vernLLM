---
'vern-llm': minor
---

`fallbackOn` is told which target failed and which one would come next.

```ts
fallbackOn: (error, { failed, next }) =>
  next && next.model !== failed.model && error.type === 'validation'
    ? 'stop'
    : defaultFallbackOn(error, { isLastTarget: !next }),
```

The context gains `failed` and `next`, both `TargetInfo` (`name`, declared `index`, `model`, `adapter`) and in the order tried, so a per call `targets` order shows up as given. `next` is left out on the last target. `failed.model` is the model that target ran, so the per call `model` shows on the primary only. The new `FallbackOnContext` type names the context.

`defaultFallbackOn` is unchanged, and its context parameter still only needs `isLastTarget`. Existing policies keep compiling and behaving the same, since they ignore the new fields. Only code that calls a `FallbackOn` by hand needs to pass `failed`.
