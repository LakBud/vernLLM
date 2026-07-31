---
'vern-llm': minor
---

Added usage reservation support to regular `call()` requests.

- Added optional `reserveUsage` and `refundUsage` hooks to `CallParams`, allowing callers to reserve quota before an LLM request and refund it when a reserved request fails.
- Reused the existing usage reservation flow so `reserveUsage` runs once per logical call rather than once per retry attempt.
- Added `LLMError('quota_exceeded')` support for typed handling of usage reservation failures.
- Ensured failed reservations do not trigger circuit breaker failures, since quota exhaustion is not a provider failure.
- Ensured refunds only run when a reservation succeeded first.
- Added tests covering reservation behavior, retry interaction, refund behavior, and circuit breaker isolation.
- Updated usage tracking documentation to include `reserveUsage` and `refundUsage` support on `call()`.
