---
'vern-llm-bedrock': patch
---

Warn when the AWS SDK retries on its own.

`fromBedrock` logs a `warn` at `VernLLM` construction, once per process, when the client's resolved `maxAttempts` is above 1, since those retries are hidden from VernLLM's retries, circuit breaker, rate limiter, and events. The client is never modified. Pass `maxAttempts: 1` to the `BedrockRuntimeClient` to silence it.
