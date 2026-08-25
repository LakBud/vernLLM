---
'vern-llm': minor
---

Computed backoff now differs by failure type when no `Retry-After` header is present. A rate limited (429) response backs off hardest, a server error (5xx) backs off somewhat more than the default curve, and every other retryable failure keeps the default curve. `getBackoffDelay` gains two new optional parameters, `rateLimited` and `serverError`, both defaulting to `false`, so any existing caller passing neither keeps today's exact behavior.
