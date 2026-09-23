---
'vern-llm': patch
---

Circuit breaker fixes.

Caller side 4xx statuses no longer count toward the breaker. 408, 425, and 429 still do.
413 is no longer retried, and the default `nonRetryableStatus` now includes 402 and 413.
`defaultFallbackOn` stops on `invalid_params`, except `unsupported_capability`.
A late success no longer closes an open circuit, and late failures no longer extend its cooldown.
`cooldownBackoff` jitter never drops a cooldown below `cooldownMs`.
`getState` reports `half-open` once the cooldown has elapsed.
