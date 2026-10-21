---
'vern-llm-usage': minor
---

Introducing `vern-llm-usage`: estimated cost, wasted spend and budgets for vern-llm calls, built only on its public middleware system.

```ts
import { VernLLM } from 'vern-llm';
import { usageMiddleware } from 'vern-llm-usage';

const usage = usageMiddleware({
  prices: { 'gpt-6-sol': { input: 1.25, output: 10 } }, // dollars per 1M tokens
  pricesAsOf: '2026-10-01',
  attribute: ['tenantId'],
  budgets: [{ key: 'tenantId', limitUsd: 50, per: 'day' }],
});
const llm = new VernLLM({ client, model: 'gpt-6-sol', middleware: [usage] });

usage.totals({ tenantId: 'acme' });
await usage.remaining({ tenantId: 'acme' });
```

It prices every call from a dated table you supply, including cache and reasoning tokens, or uses the cost the provider reports when its response carries one, and reports spend on attempts whose response was rejected as wasted. A call that would go over a dollar or token budget is rejected before any provider is contacted, as `quota_exceeded` with code `budget_exceeded`, using a worst case reservation that is settled with the real spend, so parallel calls are held against the budget before they run. An aborted stream keeps its hold as its spend, since the provider bills what it generated. Streams are metered when `finalResult` settles.

Cache hits and joins report `estimatedSavedUsd`, an estimate of the spend they spared.

`timeZone` sets the IANA zone that budget windows and `totals` follow, daylight saving included. It defaults to UTC.

It also gives `totals`, `remaining`, `costFor` for a router, typed as the exported `CostFor`, `usageLogFields` for `vern-llm-logger`, and `usage.budget_warning` and `usage.budget_exceeded` events. The default store is `memoryUsageStore`, and any object with `reserve`, `commit`, `release` and `read` works.

A new package, so nothing existing changes. It needs the `vern-llm` release that adds the `budget_exceeded` code.
