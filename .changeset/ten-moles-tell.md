---
'vern-llm': minor
---

Add `getRateLimitState(target?)`, rounding out rate limiting's introspection to match the circuit breaker's `getCircuitState()` and the retry budget's `getRetryBudgetState()`. Returns `{ requestsRemaining, tokensRemaining, concurrentInFlight }`, each `undefined` if that bucket isn't configured, or `undefined` entirely if the target has no `rateLimit` configured.

`RateLimiterAdapter` gains an optional `getState?()` method powering this. It's optional, not required: an existing custom adapter that omits it keeps working unchanged, and `getRateLimitState()` simply returns `undefined` for it, same as no limiter at all.
