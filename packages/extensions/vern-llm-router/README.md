<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-router.png" alt="vern-llm-router logo" width="96" />
</p>

<h1 align="center">vern-llm-router</h1>

<p align="center">Picks the target order for each <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> call, from rules you write.</p>

A fixed fallback order sends every call to the same first target, even when it is slow today, costs ten times what the call needs, or keeps returning answers you reject. `vern-llm-router` is one middleware that decides which of a call's targets are tried first, from rules you write and from what your own traffic measured.

It only reorders. It never adds a target, never changes what a call returns or throws, and if deciding fails the call runs exactly as it would without it.

## Installation

```bash
npm i vern-llm-router
```

`vern-llm` is a peer dependency, and the package has no other dependency.

## Quick start

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

The first route whose `when` matches decides the order. Free and trial calls go to the small model, calls with tools never do, and everything else tries `main` first.

## What you get

| Capability             | How it works                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Routes                 | Match a call by its `context`, tools, JSON output, or size                                                           |
| Strategies             | `ordered`, `weighted` (sticky per user, so a provider prompt cache stays warm), `'least-busy'`, or `rank`            |
| Ranking by measurement | Scores targets on latency, predicted latency, cost, effective cost, and quality, on a log scale so units combine     |
| Quality aware cost     | `effectiveCost` is the price divided by the share of answers that are usable                                         |
| Exploration            | A small share of calls tries a random usable target, so no target starves of data                                    |
| Health                 | A target with an open breaker or an exhausted rate limit moves to the back, and a 429 cools it for its `Retry-After` |
| Slow start             | A target whose breaker just closed ramps back in over `slowStartMs`                                                  |
| Soft limits            | A target over `latencyMs`, `costUsd`, or `qualityFailureRate` moves behind the others                                |

## Usage

### Ranking by latency and cost

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

Stats and cost are both optional, and a strategy that needs one you did not pass fails at construction, not in production.

### Trying a rule before you ship it

`router.preview({ request, context })` returns the decision a call would get right now, without calling anything:

```ts
// { route: 'bulk', strategy: 'ordered', order: ['small'], excluded: [...], demoted: [], explored: false }
```

For a rollout, set `apply: false`. Every decision is computed and emitted as a `router.decision` event and no call changes, so you can compare against the declared order before switching it on. One pure function backs real calls, `preview()`, and shadow mode, so they always agree.

### With policy

The router decides what is preferred, and [`vern-llm-policy`](https://www.npmjs.com/package/vern-llm-policy) decides what is allowed. Policy runs first and removes targets, so the router only ever orders what is left.

Register one instance per `VernLLM`.

## Documentation

See the [router docs](https://vernllm.dev/docs/extensions/router) for [routes](https://vernllm.dev/docs/extensions/router/features/routes), [strategies](https://vernllm.dev/docs/extensions/router/features/strategies), [health](https://vernllm.dev/docs/extensions/router/features/health), and [observability](https://vernllm.dev/docs/extensions/router/features/observability).

## License

MIT
