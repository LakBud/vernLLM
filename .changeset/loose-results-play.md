---
'vern-llm': minor
---

Order `position: 'outermost'` and `position: 'innermost'` claimants by registration, not by `priority`.

The docs already said that when several middleware claim `'outermost'` (or `'innermost'`), the first one registered holds the true outermost (or innermost) slot. In practice their `priority` decided it, because the claimants kept their `transform` order, which is sorted by `priority` first. A middleware that needed a late `transform` slot, for example to see the request after redaction, therefore lost its outer `wrap` slot to any other claimant with a lower priority.

Now `wrap` nesting among pinned entries follows registration order only. `priority` and `runsAfter`/`runsBefore` still decide `transform` and `onEvent` order, and entries without a pin are unaffected.

```ts
const llm = new VernLLM({
  client,
  model: 'gpt-4o',
  middleware: [
    { name: 'audit', position: 'outermost', priority: 1000, wrap: audit },
    { name: 'metering', position: 'outermost', priority: -1000, wrap: metering },
  ],
});

// Before: metering wrapped audit, because its priority was lower.
// Now: audit wraps metering, because it was registered first.
```

This changes `wrap` nesting only for setups where two entries pin the same side and their priorities disagree with their registration order. To keep the old nesting, register the entry you want outermost first. Everything else, including setups that pin a single entry or leave `priority` unset, behaves the same.
