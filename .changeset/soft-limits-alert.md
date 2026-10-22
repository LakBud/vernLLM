---
'vern-llm-usage': minor
---

Budgets take `mode: 'soft'`, which alerts without blocking. A soft budget never rejects a call and tracks spend like a hard one. When spend plus holds first reach its limit in a window, `usage.budget_exceeded` is emitted once with `mode: 'soft'` and `blocked: false`. A soft and a hard budget can share a key, unit and window, for an alert before a block.

```ts
budgets: [
  { key: 'tenantId', limitUsd: 40, per: 'day', mode: 'soft' }, // alert at $40
  { key: 'tenantId', limitUsd: 50, per: 'day' }, // block at $50
];
```

`remaining()` reports `mode` and `overBy` for every budget. `usage.budget_warning` and `usage.budget_exceeded` gain `mode`, and `usage.budget_exceeded` gains `blocked`. Existing configs, events and stored hard budget keys keep working, and custom stores need no change.
