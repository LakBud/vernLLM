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

Purely additive. Nothing about `onUsage`/`onUsageFailure`'s existing behavior, timing, or field shape changes; a handler written as a `switch` with a `default` branch should already treat unknown `kind` values as expected, the same as every prior addition to this union.
