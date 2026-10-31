<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-hedge.png" alt="vern-llm-hedge logo" width="96" />
</p>

<h1 align="center">vern-llm-hedge</h1>

<p align="center">Cuts the slow tail of <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> latency by sending a slow call to the next target too and keeping the first answer.</p>

A middleware that waits for the delay a target usually needs, and if the call is still open, starts the same call on another target. The first success is kept and the core cancels the other. It never changes what a call returns or throws, and a call it cannot hedge runs exactly as it would without it.

## Usage

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

The delay is the p95 of the logger's `attemptMs` for the first target, the stream mode and the prompt size bucket. With no samples there is no delay and no hedge, unless `delay.fallbackMs` is set. Name the logger dimension `size`, since the hedge reads the series under that name. A number or a function as `delay` needs no `stats`.

A token bucket keeps extra calls near 5% of eligible calls (`budget: { ratio: 0.05, burst: 10 }`). The bucket starts empty and the token is taken when the delay passes, so calls that answer in time cost nothing.

`targets(ctx, request)` says where the hedge may go and defaults to `nextTargets(ctx)`, the call's targets after the first. `when(ctx)` says whether a call may be hedged. Both take recipes, such as skipping calls a policy marked `duplicateSends: false`, or targets that cost more than twice the first:

```ts
import { hedgeMiddleware, nextTargets } from 'vern-llm-hedge';
import { policyFlags } from 'vern-llm-policy';

// The same target again, for a single provider.
hedgeMiddleware({ delay: 800, targets: (ctx) => [ctx.targets[0]!.name] });

// Never hedge into a target that costs more than twice the first.
hedgeMiddleware({
  stats: logger.stats,
  targets: (ctx, request) => {
    const first = usage.costFor(ctx.targets[0]!, request) ?? Infinity;
    return nextTargets(ctx).filter((name) => {
      const target = ctx.targets.find((t) => t.name === name)!;
      return (usage.costFor(target, request) ?? Infinity) <= 2 * first;
    });
  },
});

// Keep content that must not go to two providers on one.
hedgeMiddleware({
  stats: logger.stats,
  when: (ctx) => policyFlags(ctx).duplicateSends !== false,
});
```

Each call reports one `hedge.decision` with an outcome: `won`, `lost`, `not_needed`, `failed`, `aborted`, `budget`, `unavailable`, `no_target`, `not_allowed`, `paused`, `cached`, `no_data` or `deadline`. `hedgeDimension` splits the logger's counts and latency by outcome, and `hedgeLogFields(ctx)` puts the outcome on the call's record.

`maxHedges` (up to 4) sends more than one hedge, each after one more delay. `adapt: true` raises the delay of a first target whose hedges rarely win, pauses it when that stops helping, and reports a target whose hedges often win as a `hedge.adapt` event. `cacheAware: true` waits longer, or skips the hedge, when the first target served the prompt's prefix from its provider cache recently, since a hedge elsewhere starts cold. All three are off by default.

Place it at its default position `10`, inside the logger, guard, policy, usage and router. Breakers, limiters and middleware hooks apply to the extra call like any other attempt. For streams the race is on the first chunk, and the losing stream is cancelled when the winner opens.

`vern-llm` is a peer dependency and there is no other runtime dependency.
