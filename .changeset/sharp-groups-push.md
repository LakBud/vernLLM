---
'vern-llm': minor
---

Improve usage metering, cancellation handling, and reliability across call paths.

- Add abort signal support to cached call flows and usage metering hooks.
- Expose `{ coalesced, signal }` to usage reservation and refund callbacks.
- Ensure reservations are only refunded when successfully created, including cancelled requests.
- Centralize usage reservation and refund handling across `call()`, `cachedCall()`, and `cachedLLMCall()`.
- Fix circuit breaker accounting so validation, parsing, and caller cancellation failures do not count as provider failures.
