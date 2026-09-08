---
'vern-llm': minor
---

Add `usage` to `SoftFailureMeta`, the context object passed to `detectSoftFailure`. Carries the same `TokenUsage` `onUsage` would report for the attempt, `undefined` when the provider omitted it on that response, not when usage was zero.

`detectSoftFailure` is the only hook that runs before the circuit breaker records a result and whose return value can turn a technically successful response into a real failure. `onUsage` and `onUsageFailure` can already see usage, but `onUsage` fires after the breaker already recorded success and cannot change the outcome, and `onUsageFailure` only fires when a call already failed for another reason, never for a clean but expensive one. This lets a caller trip on real spend, for example reclassifying a response over a token cap as `soft_failure_detected`, using the same mechanism already used for empty or low confidence responses.

Purely additive. `usage` is optional and every existing `detectSoftFailure` implementation keeps working unchanged.
