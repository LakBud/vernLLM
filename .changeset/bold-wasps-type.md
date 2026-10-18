---
'vern-llm': minor
---

`retryBudget` accepts a `RetryBudgetAdapter`, so one budget can be shared across processes, and `readRetryBudgetState()` reads it live.

Pass an object with `assertAvailable` and `recordAttempt`, plus optional `getSnapshot`, `readState` and `setLogger`, where the options would go. Options still build the in-process `RetryBudget`, which now implements the interface. An object with only one of the two required methods, or an optional member that is not a function, throws `LLMError('invalid_params')` at construction.

`VernLLM.readRetryBudgetState(target?)` calls the adapter's `readState` and falls back to `getRetryBudgetState()`, like `readRateLimitState()` and `readCircuitStates()`.

A budget never breaks a call: a `recordAttempt` that throws or returns a rejected promise is logged, and an `assertAvailable` that throws anything but an `LLMError` is logged and the retry goes ahead. `RetryBudgetAdapter` and `RetryBudgetSnapshot` are exported.
