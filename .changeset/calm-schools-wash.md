---
'vern-llm': minor
---

`LLMErrorCode` gains `budget_exceeded` (type `quota_exceeded`) and `policy_denied` (type `invalid_params`), so packages can reject a call before any provider is contacted with a code callers can branch on. The core does not throw either one itself.

`budget_exceeded` is not retryable even though `quota_exceeded` otherwise is, since a spent budget stays spent until its window resets. Neither code counts toward the circuit breaker.

```ts
if (isLLMError(err) && err.code === 'budget_exceeded') {
  // back off until the budget window resets
}
```

Existing code keeps behaving the same at runtime. A new member on an exported union can break an exhaustive `switch` over `LLMErrorCode`, which then needs the two new cases.
