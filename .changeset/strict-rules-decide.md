---
'vern-llm-policy': minor
---

First release of `vern-llm-policy`, a middleware that decides which providers and models a call may use, and whether it may run at all. Rules allow or forbid targets by facts such as `name`, `model`, `provider` and attributes you declare, optionally `when` the call matches, and a forbid always wins. A call left with no target fails with `policy_denied` before any provider is contacted. `mode: 'audit'` reports what a rule would remove without enforcing it, and `policy.evaluate()` returns a decision from plain data for tests.

```ts
import { VernLLM } from 'vern-llm';
import { policyMiddleware } from 'vern-llm-policy';

const policy = policyMiddleware({
  targets: {
    'openai-us': { region: 'us', zdr: false },
    'openai-eu': { region: 'eu', zdr: true },
  },
  rules: [
    { id: 'suspended', forbid: 'all', when: { context: { tenantStatus: 'suspended' } } },
    { id: 'eu-residency', forbid: { not: { region: 'eu' } }, when: { context: { region: 'eu' } } },
  ],
});

const llm = new VernLLM({ client, model, fallback, middleware: [policy] });
```

A new package, so existing code keeps compiling and behaving the same at runtime. A failure of the policy itself denies the call, since `onError` is `closed` by default.
