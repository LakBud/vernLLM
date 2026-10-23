---
'vern-llm-router': minor
---

First release of `vern-llm-router`, a middleware that picks the target order for each call.

`routerMiddleware({ routes })` matches a call against routes you write, by `context`, tools, JSON output, estimated input size or a function, and the first match orders the call's targets. A route lists targets, in tiers if you like, with `*` for the rest and `exclude` to drop some. `capabilities` skips targets that cannot hold the request. A call that passes its own `targets` keeps that order, and `routerRouteKey` forces a route by name.

Every call emits a `router.decision` event after it settles, with the route, the order, what was left out and whether the order was applied. `apply: false` is shadow mode: decisions are computed and emitted, and no call changes. A failure while deciding runs the call as it would be without a router.

With `health: () => llm`, a target whose breaker is open or that is rate limited, locally or by a provider 429, goes behind the healthy ones, and a target recovering from an open breaker ramps back over `slowStartMs`.

A route's `strategy` can be `ordered`, `weighted` (with `weights`, and `stickyBy` to keep a user on one target) or `least-busy`, which compares attempts in flight.

`rank` orders targets by weighted latency, predicted latency, cost, effective cost, quality or a custom function, with `stats` and `cost` sources, soft `limits` per route, and a deadline aware step that moves targets which cannot answer in the time left behind the rest.

`router.preview({ request, context })` returns the decision a call would get right now, without calling anything. `routeDimension` and `driftDimension` are logger dimensions that split stats by route and show when the first choice is not the target that answered, which is how a shadow rollout is judged.
