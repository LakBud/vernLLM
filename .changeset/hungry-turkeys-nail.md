---
'vern-llm': minor
---

Added client-side rate limiting.

`VernLLMOptions.rateLimit` queues calls locally to stay under configured `requestsPerMinute`, `tokensPerMinute`, and/or `maxConcurrent` caps, instead of dispatching and letting the provider reject with a 429. This is proactive, unlike the existing `Retry-After` handling in the retry loop, which only reacts after a self-inflicted rate limit has already cost a round trip. Omit `rateLimit` for unlimited, exactly matching pre-existing behavior.

```ts
new VernLLM({
  client,
  model: 'gpt-4o',
  rateLimit: { requestsPerMinute: 500, maxConcurrent: 20 },
});
```

Capacity is acquired per retry attempt, not once per call, since every retry is a real request against the same limits. For `stream: true`, capacity is held for the connection's full lifetime and released only once the stream completes (success or a mid-stream failure), not when it merely opens, since a stream holds a real connection the whole time it's open.

`tokensPerMinute` is enforced against a pre-flight estimate (a chars/4 heuristic over message content plus `max_tokens` by default, overridable via `estimateTokens`), then reconciled against real reported usage once the call completes, so a systematically over- or under-estimating heuristic self-corrects rather than compounding.

A call that can't get capacity within `maxQueueMs` (default 30000, pass `0` to wait indefinitely) or finds the queue already at `maxQueueSize` (default `0`, unbounded) throws `LLMError` with `type: 'quota_exceeded'` and the new `code: 'local_rate_limit'`, reusing the existing type since a locally-stopped call before anything was sent is exactly what `quota_exceeded` already means. `shouldRetry` now excludes this code: the wait already happened, so retrying immediately would only requeue behind the same limit with nothing changed.

Provider 429s are unaffected in shape, still `type: 'api'`, `status: 429`, but now also carry the new `code: 'provider_rate_limited'` for callers that want to distinguish a real provider rate limit from a local one without checking `status` directly.

Queued waiters are served strictly FIFO, so a large call can't be starved indefinitely by a stream of smaller ones queued behind it, and a waiter whose `signal` aborts while queued is removed and rejects with `type: 'aborted'` immediately rather than continuing to hold a queue slot.

`onEvent` gains a `'rate_limited'` event, reported whenever an attempt actually had to wait for capacity, carrying `waitedMs` and which bucket (`'concurrency' | 'rpm' | 'tpm'`) was blocking it.

New exports: `RateLimiter`, `RateLimitOptions`, `RateLimitReason`, `RateLimitAcquireResult`, `WireRequest`, and `defaultEstimateTokens`.

`LLMErrorCode` gains `'local_rate_limit'` and `'provider_rate_limited'`, and `VernLLMEvent` gains the `'rate_limited'` kind, both additive to fields that were also newly introduced in this same release cycle, so nothing published to date is affected. Note for anyone consuming this as a standalone follow-on to an already-released `onEvent`/`code`: TypeScript still treats adding a member to a previously-public union as a compile-time break for consumers who exhaustively `switch` over `LLMErrorCode` or `VernLLMEvent['kind']` with a `default: never` guard (the same tradeoff already accepted for `code` itself and for `VernLLMEvent`, deliberately not extended to `LLMErrorType`, which stays closed for this reason).
