---
'vern-llm': minor
---

LLMError now carries an optional attempts array, one entry per attempt made against the current target before the error was thrown, each with that attempt's index and a snapshot of that attempt's error. Absent when nothing was retried.

Added RetryAttempt, the shape of each entry, and LLMErrorSnapshot, the shape of `RetryAttempt.error`: an inert, point-in-time copy of an LLMError's fields (message, type, code, status, issues, retryAfterMs, retryable), produced by the new `LLMError.toSnapshot()`. A recorded attempt is a record, not a live, throwable error, so `RetryAttempt.error` is a snapshot rather than an `LLMError` itself; this also keeps `RetryAttempt` from being self-referential through `LLMError.attempts`. FallbackAttempt now extends RetryAttempt instead of declaring its own index and error fields, so FallbackExhaustedError.attempts keeps its existing shape unchanged, provider and model alongside the inherited index and error.

Added isFallbackExhaustedError, a guard function for narrowing a caught error to FallbackExhaustedError without a manual instanceof check.

This is additive only. No existing field changed type or moved.
