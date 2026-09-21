---
'vern-llm': patch
---

Fix circuit breaker recovery with the rolling policy: a successful half open trial now resets the tripping window, so old failures no longer reopen the circuit right after recovery. Fix `withTimeout` to race the call against the timer, so a client that ignores the abort signal or throws its own abort error type still produces a `timeout` error.
