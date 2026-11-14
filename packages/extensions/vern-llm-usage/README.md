<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-usage.png" alt="vern-llm-usage logo" width="96" />
</p>

<h1 align="center">vern-llm-usage</h1>

<p align="center">Estimated cost, wasted spend and budgets for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> calls.</p>

Providers report tokens, not dollars, and a budget checked after the call is a report, not a limit. `vern-llm-usage` is one middleware with two jobs. It is a meter: it prices the token counts vern-llm already reports with a price table you supply. It is also a cut off switch: it holds an estimate against your budgets before each call and rejects the call, with no provider contacted, when it would go over.

## Installation

```bash
npm i vern-llm-usage
```

`vern-llm` is a peer dependency, and the package has no other dependency.

## Quick start

```ts
import { VernLLM } from 'vern-llm';
import { usageMiddleware } from 'vern-llm-usage';

const usage = usageMiddleware({
  prices: { 'gpt-6-sol': { input: 1.25, output: 10, cacheRead: 0.125 } }, // $ per 1M tokens
  pricesAsOf: '2026-10-01',
  attribute: ['tenantId'],
  budgets: [{ key: 'tenantId', limitUsd: 50, per: 'day' }],
  warnAt: 0.8,
});

const llm = new VernLLM({ client, model: 'gpt-6-sol', middleware: [usage] });

await llm.call({ userContent: 'Summarize this', jsonMode: false, context: { tenantId: 'acme' } });

usage.totals({ tenantId: 'acme' }); // spend today, cache hits, unpriced charges
await usage.remaining({ tenantId: 'acme' }); // what is left of each budget
```

A call over budget throws an `LLMError` with type `quota_exceeded` and code `budget_exceeded`. It never counts toward the circuit breaker, and the default fallback policy does not try another target for it.

## What you get

| Capability                 | How it works                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Cost per call              | Cache reads, cache writes by TTL, and reasoning tokens each get their own rate                                           |
| Sums that never drift      | Money is held as integer nano dollars                                                                                    |
| Wasted spend               | `wastedUsd` splits out spend on attempts whose response was rejected, `unkeptUsd` spend on chains that lost a race       |
| Budgets that reject early  | The worst case is held on every budget or none, before a provider is contacted                                           |
| Soft and hard budgets      | A soft budget alerts and never blocks, so you can warn at $40 and block at $50 on the same key                           |
| Calendar windows           | Per hour, day, or month, in your time zone                                                                               |
| Holds that free themselves | A reservation that is never settled is released after 10 minutes                                                         |
| Provider reported cost     | When a provider reports what a call cost, such as OpenRouter's `usage.cost`, that figure wins and is tagged `'reported'` |

Budget warnings and rejections are emitted as `usage.budget_warning` and `usage.budget_exceeded` events. Streams are metered when `finalResult` settles.

## Usage

### Cost on every log record

Pass `usageLogFields` to `vern-llm-logger`'s `enrich` and each record carries its cost:

```json
{ "estimatedCostUsd": 0.0031, "wastedUsd": 0, "costSource": "table" }
```

A cache hit costs nothing and carries `estimatedSavedUsd` instead.

### One budget across processes

The default store lives in one process. Use `redisUsageStore` from [`vern-llm-redis`](https://www.npmjs.com/package/vern-llm-redis), or your own `UsageStore`, when several processes must agree on one budget.

## What it is not

Costs are named `estimatedCostUsd` everywhere, because they are your prices times the provider's token counts. The provider's invoice decides what you pay, and budgets are guards, not ledgers. There is no built in price table: prices come only from the table you pass, with the date you last checked it, so nothing goes stale without telling you.

Register one instance per `VernLLM`.

## Documentation

See the [usage docs](https://vernllm.dev/docs/extensions/usage) for [cost](https://vernllm.dev/docs/extensions/usage/features/cost), [budgets](https://vernllm.dev/docs/extensions/usage/features/budgets), [stores](https://vernllm.dev/docs/extensions/usage/features/stores), and every option.

## License

MIT
