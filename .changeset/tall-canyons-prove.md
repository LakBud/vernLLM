---
'vern-llm': patch
---

Fixed two bugs found during a code review pass:

`FallbackExhaustedError` now inherits `retryAfterMs` from the last failed target's error, matching
the `type`/`status`/`cause` it already inherited. Previously `retryAfterMs` was hardcoded to
`undefined`, so a caller following the documented pattern of reading `err.retryAfterMs` on an
`'api'`-typed error would silently lose the provider's actual Retry-After value in the one case
where every target, including the last, failed with a rate limit.

`RateLimiter`'s internal `TokenBucket` no longer loses already-refilled capacity when the system
clock moves backward (NTP correction, VM migration, etc.). A negative elapsed time between refills
was previously multiplied straight into the bucket's `available` count, silently discarding real
capacity and rate-limiting harder than configured until the bucket caught back up. Elapsed time
below zero is now treated as no time having passed, rather than negative time.

Also removed a dead-code `maxQueueSize` check in `RateLimiter.acquire`'s fast path (the queue is
always empty there, so the check could never fire); no behavior change.
