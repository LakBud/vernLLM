---
'vern-llm': minor
---

`FallbackTarget.circuitBreaker` now accepts a `CircuitBreakerAdapter`, so a fallback target's health can be shared across instances or processes. Options and `true` behave as before, and the breaker is still never inherited from the parent instance.
