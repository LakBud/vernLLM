---
'vern-llm-logger': minor
---

A call refused by a middleware for its content, with the code `content_blocked`, is logged as `rejected` at `warn`, like a budget or policy refusal, and no longer counts as an error. Custom events in the `guard.*` namespace are kept by default, next to `usage.*`, `policy.*` and `router.*`.
