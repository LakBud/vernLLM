---
'vern-llm-redis': patch
---

Fix a missed wake in the rate limiter. A release published before the subscriber's `SUBSCRIBE` was confirmed was lost, so a waiter only woke on the next poll. `acquire` now waits for the subscription first, bounded by the poll interval.
