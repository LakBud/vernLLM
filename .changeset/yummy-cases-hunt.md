---
'vern-llm-bedrock': patch
---

Warn when the AWS SDK retries on its own.

`fromBedrock` logs a `warn` at `VernLLM` construction, once per process, when the client's resolved `maxAttempts` is above 1, since those retries are hidden from VernLLM's retries, circuit breaker, rate limiter, and events. The client is never modified. Pass `maxAttempts: 1` to the `BedrockRuntimeClient` to silence it. An explicit `retryStrategy` overrides `maxAttempts`, so remove it or configure it for one attempt. The warning reads the attempt count of the SDK's own `StandardRetryStrategy` and `AdaptiveRetryStrategy`, including one you pass in. A fully custom strategy exposes no count, so it can't be checked and gets no warning even if it still retries.
