---
'vern-llm': minor
---

Added application-controlled usage metering to normal LLM calls.

- Added `reserveUsage` and `refundUsage` options to `call()` for quota, budget, or capacity management before and after provider requests.
- Added `quota_exceeded` as a typed `LLMError` variant for failed usage reservations.
- Usage reservations run once per logical call, not once per retry attempt.
- Failed calls refund usage only when a reservation succeeded.
- Reservation failures do not trigger circuit breaker failures because they are not provider failures.
- Extended usage metering behavior to work consistently with `cachedCall` and `cachedLLMCall`, including concurrent request coalescing metadata.
- Prevented duplicate reservations in `cachedLLMCall` when usage hooks are provided at the cache wrapper level.
- Added request lifecycle tests covering reservation ordering, refunds, retry behavior, circuit breaker isolation, cached call behavior, and usage hook edge cases.
- Updated docs and added a `usage-metering.mdx` page
