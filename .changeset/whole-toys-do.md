---
'vern-llm': minor
---

Add `'usage'` and `'usage_failure'` to `VernLLMEvent`, so a middleware's own `onEvent` can observe token usage the same way it already observes `retry`/`fallback`/`rate_limited`/`circuit_state`.

`VernLLMOptions.onUsage`/`onUsageFailure` are unchanged. They're now driven from these same two events rather than a separate reporting path, so they and a middleware's `onEvent` observe identical data independently: neither knows the other ran, and a throwing handler in one can't stop the other from running.

```ts
import type { VernLLMMiddleware } from 'vern-llm';

const costTracking: VernLLMMiddleware = {
  name: 'cost-tracking',
  onEvent: (event) => {
    if (event.kind === 'usage') {
      recordTokenCost(event.requestId, event.usage.totalTokens);
    }
  },
};
```

Minor, not breaking at runtime. Nothing about `onUsage`/`onUsageFailure`'s existing behavior, timing, or field shape changes, and a handler written as a `switch` with a `default` branch already treats unknown `kind` values as expected.

An exhaustive `switch` over `event.kind` with no `default` (e.g. an `assertNever(event)` fallback) will fail to compile until it adds cases for `'usage'` and `'usage_failure'`, the same as every prior addition to this union. Add the two new cases wherever such a switch exists; each new case can simply call the same logic as `default` used to, or a no op if usage was never handled there.
