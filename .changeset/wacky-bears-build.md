---
'vern-llm': patch
---

Warn when a provider SDK retries on its own.

`fromOpenAICompatible` (and every alias such as `fromOpenAI`), `fromAnthropic`, and `fromGemini` log a `warn` at `VernLLM` construction, once per process for each SDK, when the wrapped SDK client would retry failed requests itself, since those retries are hidden from VernLLM's retries, circuit breaker, rate limiter, and events. Nothing else changes at runtime: the client is never modified. Pass `maxRetries: 0` to OpenAI and Anthropic clients, and leave out `httpOptions.retryOptions` on Gemini, to silence it.
