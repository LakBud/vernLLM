---
'vern-llm': minor
---

Added cross-provider fallback, declared inline on the constructor.

`VernLLMOptions.fallback` takes an ordered `FallbackTarget | FallbackTarget[]`, each with its own `client`/`model` and, optionally, its own `maxRetries`, `timeoutMs`, `chunkIdleTimeoutMs`, `baseDelayMs`, `defaultMaxTokens`, `defaultTemperature`, `nonRetryableStatus`, `circuitBreaker`, and `rateLimit` (per-target overrides fall back to the parent instance's own option when omitted; `circuitBreaker`/`rateLimit` are never inherited, each target's is independent of every other target's). Order is the policy: `VernLLM` never reorders, scores, or health-checks targets, it only walks the list as given, after the primary and after each earlier fallback target is exhausted or abandoned.

```ts
const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  fallback: [
    { client: anthropic, model: 'claude-sonnet-5', name: 'anthropic' },
    { client: gemini, model: 'gemini-2.5-flash', name: 'gemini' },
  ],
});
```

`VernLLMOptions.fallbackOn` decides what happens once a target's own retries are exhausted or abandoned early: `'next'` moves on to the following target, `'stop'` gives up immediately. `'retry'` isn't a valid return here, retrying already happened inside the target. Defaults to the new exported `defaultFallbackOn`, which stops on `parse`/`validation`/`aborted`/`quota_exceeded` errors and on tool-contract failures (`code: 'unknown_tool'`/`'duplicate_tool_call_id'`, the model ignoring the request rather than the provider being unhealthy) since none of those are fixed by trying a different provider, and moves on for everything else, including a rate-limited or open-circuit target. Exported so a caller can wrap rather than replace it.

Every target keeps its own retry state, circuit breaker, and rate limiter, so tripping one target's breaker never affects another's. A `circuitBreaker`-open primary now falls over to the next target instead of hard-failing the call, since an open breaker is just another target failure as far as `fallbackOn` is concerned.

`CallParams.meta`, an optional `{ current?: CallMeta }` out-parameter, is written with `{ provider, model, fallbackIndex, usedFallback, attempts }` once `call()` resolves, so a caller who wants provider identity on the same line as the result doesn't need to read it back out of `onUsage`. Ignored for `stream: true`, since `call()` returns before the outcome (and so the target that answered) is known; `TokenUsage.provider`/`usedFallback` from `onUsage` cover that case instead. `TokenUsage` gains `usedFallback?: boolean` alongside the existing `provider?: string`.

`onEvent` gains a `'fallback'` event, reported when the chain moves to the next target, carrying `from`/`to` provider names, `fromIndex`/`toIndex` (`-1` for the primary), the normalized error that caused the move, and `elapsedMs` spent on the abandoned target.

When every target fails, `call()` throws the new `FallbackExhaustedError` (extends `LLMError`, so `isLLMError`/`instanceof LLMError` still passes, inheriting the last failure's `type`), carrying `attempts: FallbackAttempt[]`, every target's own normalized error in order, so a cross-provider outage stays debuggable without reproducing it. A lone target (no `fallback` configured) throws exactly what it throws today, unchanged: the single-iteration path is identical to pre-fallback behavior.

Fallback applies to stream-open failures only. Once a chunk has been emitted, `VernLLM` does not fall over mid-stream, since splicing a second model's output into a response the consumer has already partially rendered would corrupt it; a stream-open failure (before the first chunk) falls over exactly like a non-streaming failure does.

`cachedCall` composes with fallback automatically, since fallback lives inside `call()`: the whole chain caches under one key and the successful result, however far down the chain it came from, is what gets stored, with in-flight coalescing covering the full chain too.

`LLMErrorCode` gains `'fallback_exhausted'`, additive.

New exports: `FallbackTarget`, `FallbackOn`, `FallbackAttempt`, `CallMeta`, `FallbackExhaustedError`, `defaultFallbackOn`.

Tests added covering: primary success leaving every fallback target untouched, falling over on primary exhaustion with a byte-identical wire request (including `tools`) reaching the next target, `parse`/`validation`/`quota_exceeded`/tool-contract errors stopping the chain instead of falling over, a rate-limited or circuit-open target falling over, per-target breaker independence, `FallbackExhaustedError.attempts` carrying every failure in order, the no-fallback-configured case throwing identically to pre-fallback behavior, the stream-open-only limitation, `cachedCall` storing the fallback-produced result, `TokenUsage` identity matching whichever target answered, the default and a custom `fallbackOn` policy, and the `'fallback'` event. Also added real-SDK integration tests driving actual `openai`, `@anthropic-ai/sdk`, `@google/genai`, and `@aws-sdk/client-bedrock-runtime` clients, each as a distinct fallback target against its own local mock server, exercising a full four-provider fallback chain, a real streaming open-failure fallover, and `FallbackExhaustedError` collecting every real provider's parsed error.
