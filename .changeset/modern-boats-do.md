---
'vern-llm': minor
---

A call can seed `ctx.state` before any middleware runs, with the new `state` param and `stateEntry` helper.

```ts
const routeDecisionKey = createStateKey<RouteDecision>('router.decision');

await llm.call({ userContent, state: [stateEntry(routeDecisionKey, decision)] });
```

`stateEntry` checks the value against the key's type. Raw `[key, value]` pairs also work, and a later entry wins over an earlier one with the same key. `createMiddlewareStateBag` accepts the same entries. The seed is never sent to the provider, never reported on events or usage, and not part of the `cachedCall` cache key. With `cachedCall`, each caller's `wrap` sees that caller's `state`, while the shared request sees the state of the caller that started it. Anything that isn't an array of `[key, value]` pairs throws `invalid_params` with the new code `invalid_state`, before any hook runs.

Existing code keeps compiling, and nothing changes at runtime until a call passes `state`.
