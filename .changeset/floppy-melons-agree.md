---
'vern-llm': patch
---

Fix: a `quota_exceeded` failure no longer counts toward the circuit breaker.

`LLMError.countsTowardBreaker` is now distinct from `LLMError.retryable`. A usage reservation
rejection is a caller or account level limit, not a signal that the provider itself is unhealthy,
so repeated `quota_exceeded` failures no longer push a healthy provider's circuit toward opening,
even though they're still retried. Every other error type is unaffected.

`CircuitBreaker.recordFailure` also accepts a new optional fourth argument, the failing error's
`LLMErrorCode`. It isn't read yet, existing calls are unaffected, and this lands ahead of upcoming
circuit breaker attribution work.
