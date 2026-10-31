<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-usage.png" alt="vern-llm-usage logo" width="96" />
</p>

<h1 align="center">vern-llm-usage</h1>

<p align="center">Estimated cost, wasted spend and budgets for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> calls.</p>

One middleware with two jobs. It is a meter: it prices the token counts vern-llm already reports with a price table you supply, and separates spend on attempts whose response was then rejected. It is also a cut off switch: it holds an estimate against your budgets before each call and rejects the call, with no provider contacted, when it would go over.

## Usage

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

A call over budget throws an `LLMError` with type `quota_exceeded` and code `budget_exceeded`. It never counts toward the circuit breaker. Streams are metered when `finalResult` settles. Pass `usageLogFields` to `vern-llm-logger`'s `enrich` to put cost on every log record, and budget warnings and rejections are emitted as `usage.budget_warning` and `usage.budget_exceeded` events.

When a provider reports what a call cost, such as OpenRouter's `usage.cost`, that figure is used instead of your table and the call's `costSource` is `'reported'`.

Costs are named `estimatedCostUsd` everywhere, because they are your prices times the provider's token counts. The provider's invoice decides what you pay, and budgets are guards, not ledgers.

Register one instance per `VernLLM`. `vern-llm` is a peer dependency, and the package has no other dependency. The default store lives in one process: use a shared `UsageStore` when several processes must agree on one budget.

See the [documentation](https://vernllm.dev/docs/extensions/usage) for every option.
