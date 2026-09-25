---
'vern-llm': minor
---

Caching, rate limiting, retry, fallback, middleware, and streaming fixes, plus a new `response_truncated` error code.

Caching: `NormalizedCacheAdapter` no longer strips punctuation or case, so `"2+2"` and `"2-2"` no longer share an answer. It only normalizes Unicode composition, line endings, and outer whitespace. `InMemoryCacheAdapter` copies values on write and read, and a missing, NaN, zero, or negative `ttl` stores nothing instead of an entry that never expires. `cachedCall` warns when `ttl` is missing or NaN. `TieredCacheAdapter` no longer serves a value after L2 has expired it.

Rate limiting: the default token estimate counts each image as 1,600 tokens instead of reading its base64 as text. AIMD shrinks at most once per 60 seconds. A blank rate limit header is treated as missing, and all zero usage keeps the estimate. An error thrown by a limiter's `estimate` or `acquire` never counts toward the circuit breaker.

Retries: a negative or NaN `maxRetries` means one attempt instead of none, with a warning. Output cut off at `max_tokens` that fails to parse throws `LLMError('parse')` with the new code `response_truncated`, which is retried and never counts toward the breaker. `fromAnthropic`, `fromGemini`, and `fromBedrock` report when they stopped at `max_tokens`. Custom clients can set `finish_reason: 'length'` on a choice.

Fallback: a per call `model` override applies to the primary target only. Fallback targets run their own `model`, and every report of the model names the one each target ran.

Middleware: `ctx.own` persists for one middleware across all its hooks within a logical call. An unnamed middleware is labeled `[i]` everywhere, including `ctx.registeredMiddlewareNames`. The response body in a `fromFetch` error passes through `redact`. A circuit transition with no call behind it reaches middleware `onEvent`.

Streaming: a stream that fails before its first content chunk is retried and falls back, even after a keep-alive ping opened it. `call()` still resolves on the first ping, so a long thinking phase stays outside `timeoutMs`. `chunks` and `finalResult` follow whichever attempt produces content, and `meta.current` is updated in place if a different target answers.

Existing code keeps compiling unless it has an exhaustive `switch` over `LLMErrorCode`, which needs a case for `response_truncated`. At runtime: prompts that only matched through case or punctuation stop sharing a cache entry, code that matched an unnamed middleware in `registeredMiddlewareNames` by its bare index must use `[i]`, and a failure between a ping and the first content chunk now retries instead of rejecting `finalResult`.
