<h1 align="center">vern-llm-router</h1>

<p align="center">Picks the target order for each <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> call, from rules you write.</p>

A middleware that reorders the targets a call may try. It never adds a target, never changes what a call returns or throws, and if deciding fails the call runs exactly as it would without it.

## Usage

```ts
import { VernLLM } from 'vern-llm';
import { routerMiddleware } from 'vern-llm-router';

const router = routerMiddleware({
  health: () => llm, // lazy, since llm is created after this middleware
  routes: [
    { name: 'bulk', when: { context: { tier: ['free', 'trial'] } }, targets: ['small'] },
    { name: 'tools', when: { hasTools: true }, exclude: ['small'] },
    { name: 'default', targets: [['main'], '*'] },
  ],
  capabilities: { small: { contextWindow: 32_000, tools: false } },
});

const llm = new VernLLM({
  client,
  model: 'main',
  fallback: [{ client: smallClient, model: 'mini', name: 'small' }],
  middleware: [router],
});
```

The first route whose `when` matches decides the order. `targets` takes names, tiers (`[['a', 'b'], ['c']]`) and `'*'` for every target not named. A call that passes `targets` keeps its own order. Force a route for one call with `state: [stateEntry(routerRouteKey, 'bulk')]`.

A route's `strategy` orders its targets inside each tier. `ordered` (the default) keeps the order you wrote. `{ type: 'weighted', weights, stickyBy? }` puts a weighted random pick first and the rest by weight, and with `stickyBy` a user's context value is hashed instead, so the same user keeps the same first target and its provider prompt cache stays warm. `'least-busy'` samples two targets (by `weights`, when given) and puts the one with fewer attempts in flight, divided by its weight, first. Consecutive names in `targets` form one tier, so `targets: ['a', 'b', 'c']` is what a strategy chooses between.

`rank` scores every target on weighted metrics and puts the best first: `latency`, `predictedLatency`, `cost`, `effectiveCost`, `quality` and your own `custom` function. Each metric is how many times worse than the best target, on a log scale, so different units combine and one outlier only hurts itself. A target within `tolerance` (default 0.2) of the best shares first place by closeness, and with chance `explore` (default 0.05) a random usable target goes first so every target keeps being measured. `'latency'`, `'cost'` and `'balanced'` are shorthands. Targets with an unknown value score at the median of the known ones.

```ts
const router = routerMiddleware({
  stats: logger.stats, // vern-llm-logger: quantile() and failureRate()
  cost: usage.costFor, // vern-llm-usage
  routes: [
    { name: 'bulk', when: { context: { feature: 'tag' } }, strategy: 'cost' },
    { name: 'default', strategy: 'balanced', limits: { latencyMs: 3_000 } },
  ],
});
```

`predictedLatency` is the streamed time to first token plus this route's typical answer length at the target's generation speed, so a slow starting, fast generating provider wins long answers. `effectiveCost` is the price divided by the share of answers that are usable. `quality` is the share of responded attempts rejected as unusable, read for the route first and for the target overall below that. Both stats and cost are optional, and a strategy that needs one you did not pass fails at construction. Stats reads are reused for `statsTtlMs` (default 1000).

`limits` are soft: a target over `latencyMs`, `costUsd` or `qualityFailureRate` moves behind the others, and if all are over, the order stays. A call with `deadlineMs` also moves targets that cannot answer in the time left behind the rest, on every strategy.

With `health`, a target whose breaker is open goes last, then one that is rate limited (a local limit used up, or a provider 429 still cooling down for its `Retry-After`, 5 seconds without one). A half open target keeps its place so its trial runs, and if every target is unhealthy the order stays as it is. After a breaker closes, a target ramps back over `slowStartMs` (default 30 seconds, `0` turns it off) and may give way to the next healthy one meanwhile. A route with `health: false` skips the open and limited step.

A route that leaves no target at all, through `exclude` or `targets`, fails the call with `no_eligible_targets`, since that is a configuration error. The capability filter never does: when no target is known to fit, all stay.

Each call emits a `router.decision` event after it settles: the route, the order, what was excluded and why, and `applied`. Set `apply: false` to run in shadow mode, where decisions are computed and emitted and every call keeps its declared order.

`router.preview({ request, context })` returns the decision a call would get right now without calling anything, and needs `health`. `routeDimension` and `driftDimension` are logger dimensions that split stats by route and show whether the router's first choice is the target that answered:

```ts
loggerMiddleware({ dimensions: { route: routeDimension, drift: driftDimension } });
```

Register one instance per `VernLLM`. `vern-llm` is a peer dependency, and the package has no other dependency.
