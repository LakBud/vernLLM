---
'vern-llm': minor
---

Add `retryBudget`, capping how much of a target's recent traffic is allowed to be retries,
independent of the circuit breaker.

`maxRetries` only bounds one call's own retries. A target can be perfectly healthy, never opening
its breaker, while every single call still needs a retry, and today nothing catches that:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  retryBudget: { windowMs: 60_000, minCalls: 10, retryRatio: 0.1 },
});
```

Once at least `minCalls` calls have landed in the trailing `windowMs` and the fraction of them that
were retries reaches `retryRatio`, further retries against that target throw
`LLMError('rate_limited')` with `code: 'retry_budget_exhausted'` instead of retrying. `minCalls`
gates the check the same way it already does for `tripping: { kind: 'rolling', ... }`, so a cold
start with too little traffic to judge doesn't trip. Reuses the same `RollingRatio` primitive
`RollingTripping` is built on. `minCalls` and `retryRatio` are validated at construction (a
non-negative integer, and a finite number in `[0, 1]`, respectively), thrown as `RangeError`.

The breaker and the budget are independent gates asking different questions, breaker health vs
retry cost, and never fire for the same reason: the breaker's gate runs once per logical call,
before it starts; the budget's gate runs fresh at each retry, inside the call's own loop. A call
can clear the breaker and still get cut off by the budget mid retry, distinguishable by `code`
(`circuit_cooling_down`/`circuit_trial_in_flight` vs `retry_budget_exhausted`).

`retryBudget` is built once per target, same as `circuitBreaker`/`rateLimit`, and `fallback`
targets get their own, never inherited from the parent. Every model routed through one target
shares one budget, since a budget protects that target's real capacity regardless of which model
a call asked for.

```ts
llm.getRetryBudgetState();
// { attempts: 42, retryRatio: 0.07 }

llm.getRetryBudgetState({ index: 1 }); // first fallback target
```

`undefined` for a target with no budget configured. Omitting `retryBudget` entirely keeps today's
exact behavior. Adds `retry_budget_exhausted` as a new `LLMErrorCode`. See [Retry
Budget](/docs/core/retry-budget) for details.
