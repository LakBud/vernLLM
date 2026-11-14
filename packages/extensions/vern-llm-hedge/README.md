<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-hedge.png" alt="vern-llm-hedge logo" width="96" />
</p>

<h1 align="center">vern-llm-hedge</h1>

<p align="center">Cuts the slow tail of <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> latency by sending a slow call to the next target too and keeping the first answer.</p>

Most calls answer quickly, and a few take many times longer. A timeout with fallback only helps after the wait is already over. `vern-llm-hedge` is one middleware that cuts that slow tail: when a call's first answer takes longer than that target usually takes, it starts the same call on the next target too, keeps whichever answers first, and lets the core cancel the other.

It never changes what a call returns or throws, and a call it cannot hedge runs exactly as it would without it.

## Installation

```bash
npm i vern-llm-hedge
```

`vern-llm` is a peer dependency and there is no other runtime dependency. The default delay is learned from the latency stats of [`vern-llm-logger`](https://www.npmjs.com/package/vern-llm-logger), which is optional if you set the delay yourself.

## Quick start

```ts
import { VernLLM } from 'vern-llm';
import { loggerMiddleware } from 'vern-llm-logger';
import { hedgeDimension, hedgeMiddleware, promptSizeDimension } from 'vern-llm-hedge';

const logger = loggerMiddleware({
  dimensions: { size: promptSizeDimension, hedge: hedgeDimension },
});

const hedge = hedgeMiddleware({ stats: logger.stats });

const llm = new VernLLM({
  client,
  model: 'main',
  fallback: [{ client: backupClient, model: 'backup-model', name: 'backup' }],
  middleware: [logger, hedge],
});
```

The dimension must be named `size`, since the hedge reads the series the logger recorded under that name.

## How it stays cheap

| Concern                            | What the hedge does                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| When to hedge                      | After the live p95 of the first target, for that stream mode and prompt size. No data, no hedge          |
| How much extra traffic             | A token bucket holds extra calls near 5 percent of eligible calls (`budget: { ratio: 0.05, burst: 10 }`) |
| Calls that answer in time          | Cost nothing: the bucket starts empty and a token is taken only when the delay passes                    |
| A provider that is slow everywhere | The budget stops the hedge from doubling a struggling provider's load                                    |
| The extra call itself              | Goes through the same breakers, limiters, and middleware hooks as any other attempt                      |

## What it does and does not do

| Hedge does                                                              | Hedge does not                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Start an extra chain after a learned delay, up to four with `maxHedges` | Hedge without spare budget, or when no data says how long to wait               |
| Keep the first chain that succeeds, and cancel the other                | Retry a failed call, the core's retries and fallback do that                    |
| Go through the same breakers, limiters and hooks as any attempt         | Import the router, policy or usage                                              |
| Report one `hedge.decision` per call, sent or skipped                   | Guarantee the loser cost nothing: a hedge can still bill for the call that lost |

## Usage

### Choosing where and when to hedge

`targets(ctx, request)` says where the hedge may go and defaults to the call's targets after the first. `when(ctx)` says whether a call may be hedged at all:

```ts
import { hedgeMiddleware, nextTargets } from 'vern-llm-hedge';
import { policyFlags } from 'vern-llm-policy';

// The same target again, for a single provider.
hedgeMiddleware({ delay: 800, targets: (ctx) => [ctx.targets[0]!.name] });

// Keep content that must not go to two providers on one.
hedgeMiddleware({
  stats: logger.stats,
  when: (ctx) => policyFlags(ctx).duplicateSends !== false,
});
```

A number or a function as `delay` needs no `stats`.

### Seeing whether it pays off

Each call reports one `hedge.decision` with an outcome such as `won`, `lost`, `not_needed`, `budget`, or `no_data`. `hedgeDimension` splits the logger's counts and latency by outcome, so you can see how often a hedge wins before raising `budget.ratio`.

### Options that are off by default

- **`maxHedges`** (up to 4) sends more than one hedge, each after one more delay.
- **`adapt: true`** waits longer on a first target whose hedges rarely win, then pauses it.
- **`cacheAware: true`** waits longer, or skips the hedge, when the first target has the prompt cached, since a hedge elsewhere starts cold.

For streams the race is on the first chunk, and the losing stream is cancelled when the winner opens.

## Documentation

See the [hedge docs](https://vernllm.dev/docs/extensions/hedge) for [delay](https://vernllm.dev/docs/extensions/hedge/features/delay), [budget](https://vernllm.dev/docs/extensions/hedge/features/budget), [streams](https://vernllm.dev/docs/extensions/hedge/features/streams), [recipes](https://vernllm.dev/docs/extensions/hedge/features/recipes), and [observability](https://vernllm.dev/docs/extensions/hedge/features/observability).

## License

MIT
