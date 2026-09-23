---
'vern-llm': patch
---

Circuit breaker fixes.

Caller side 4xx statuses no longer count toward the breaker. 408, 425, and 429 still do.
413 is no longer retried, and the default `nonRetryableStatus` now includes 402 and 413.
`defaultFallbackOn` stops on `invalid_params`, except `unsupported_capability`.
Outcomes from calls admitted before the latest open are ignored, so they can't close the circuit, extend its cooldown, or count against a recovered generation.
`cooldownBackoff` never drops a cooldown below `cooldownMs`, even with a multiplier below 1, unless `maxMs` is lower.
`getState` reports `half-open` once the cooldown has elapsed.
Rolling tripping now trips under `isolateByModel`. A success no longer wipes that model's rolling window.
