---
'vern-llm': minor
---

Improve usage metering lifecycle handling across request paths.

- Add usage reservation and refund support to cached call flows without duplicating logic.
- Add abort-aware usage hooks with `{ coalesced, signal }` context.
- Refund successful reservations when requests are cancelled before execution begins.
- Improve reservation and refund failure handling without changing call error semantics.
- Prevent validation, parsing, and caller cancellation errors from being recorded as circuit breaker failures.
