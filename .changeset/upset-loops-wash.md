---
'vern-llm': minor
---

LLMError now carries an optional attempts array, one entry per attempt made against the current target before the error was thrown, each with that attempt's index and its own normalized error. Absent when nothing was retried.

Added RetryAttempt, the shape of each entry. FallbackAttempt now extends RetryAttempt instead of declaring its own index and error fields, so FallbackExhaustedError.attempts keeps its existing shape unchanged, provider and model alongside the inherited index and error.

Added isFallbackExhaustedError, a guard function for narrowing a caught error to FallbackExhaustedError without a manual instanceof check.

This is additive only. No existing field changed type or moved.
