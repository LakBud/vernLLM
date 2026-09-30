---
'vern-llm': minor
---

A call, or a `wrap`, can choose which configured targets to try and in what order. Nothing is created per call, and core runs the list it is given without choosing it.

```ts
await llm.call({ userContent, targets: ['bedrock', 'primary'] });

const policy: VernLLMMiddleware = {
  name: 'policy',
  wrap: (request, next, ctx) =>
    next({
      targets: ctx.targets.filter((t) => t.adapter.provider === 'anthropic').map((t) => t.name),
    }),
};
```

`targets` selects by name. Each `wrap` sees the order it can use as `ctx.targets` (`TargetInfo`: `name`, declared `index`, `model`, `adapter`) and may reorder or drop through `next({ targets })`, outermost first. An inner `wrap` can never widen the order: a name an outer one removed is ignored and logged. An unknown name throws `invalid_params` with the new code `unknown_target`, and an empty or repeating order, or one with nothing left, throws `no_eligible_targets`, both before any provider is contacted.

Events, `FallbackAttempt.index`, `fallbackIndex` and `usedFallback` keep the declared indices. The new `CallMeta.position` is where the answering target sat in the order tried, and `fallbackOn`'s `isLastTarget` follows the order tried. The per call `model` still applies to the primary only. `targets` is not part of the `cachedCall` cache key, and a coalesced follower's `targets` are ignored.

Existing code keeps compiling unless it has an exhaustive `switch` over `LLMErrorCode`, which needs a case for `unknown_target` and `no_eligible_targets`, or builds `PreDispatchContext` or `CallMeta` objects by hand, which need `targets` and `position`. At runtime nothing changes until a call passes `targets` or a `wrap` passes it to `next`.
