---
'vern-llm': major
---

Stopping a stream early cancels it, tool arguments come back as the `argumentsSchema` output, and invalid rate limits throw.

Streaming: leaving a `for await` over `chunks` before the end, by `break`, `return`, a throw in the loop body, or `return()`, cancels the provider stream. `finalResult` rejects with `LLMError('aborted')` and the rate limiter slot is freed. A stream that already finished is left alone. On a `cachedCall()` miss, only that caller leaves: the shared stream keeps running, and is cached, while another caller waits on it.

Tools: `ToolCall.arguments` is now the `argumentsSchema` output, so defaults, coercion and transforms apply. Tools without a schema are unchanged.

Rate limiting: `RateLimiter` throws `LLMError('invalid_params')` at construction for a negative, `NaN` or `Infinity` limit, a `requestsPerMinute` or `tokensPerMinute` between 0 and 1, a fractional `maxConcurrent` or `maxQueueSize`, a `maxQueueMs` past `2147483647`, a bad `aimd.proactiveFloor`, and `aimd` without `requestsPerMinute`. `0` still means unlimited.
