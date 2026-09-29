---
'vern-llm': major
---

`promptTokens` is now every input token the provider processed, cache reads and writes included, and `TokenUsage` reports the cache split.

Usage: `fromAnthropic` adds `cache_read_input_tokens` to `promptTokens` and `totalTokens`, on top of the cache writes it already counted. Streams take the input counts from the final `message_delta` when it sends them, since they are cumulative totals, as Anthropic's own SDK does. OpenAI compatible adapters and `fromGemini` already worked this way, and `fromFetch` reports what `mapResponse` returns. `TokenUsage` gains `cacheReadTokens`, `cacheWriteTokens` and `cacheWriteTokensByTtl`, each a subset of `promptTokens` and `undefined` when the provider doesn't report it. The wire usage gains `prompt_tokens_details` with `cached_tokens`, `cache_write_tokens` and `cache_write_tokens_by_ttl`. `fromOpenAICompatible` fills `cached_tokens` from DeepSeek's `prompt_cache_hit_tokens`, and `fromFetch`'s `mapResponse` can return the three cache counts.

Rate limiting: `LLMClient` gains `cacheReadsCountTowardRateLimit`, default `true`. `fromAnthropic` sets it to `false`, since Anthropic's input limit skips cache reads, so the token rate limiter reconciles against the total less `cacheReadTokens` and its numbers don't change.

```ts
// Before: cache reads were left out of promptTokens on Anthropic
const total = usage.promptTokens + (usage.cacheReadTokens ?? 0);

// After: promptTokens already includes them
const total = usage.promptTokens;
```

Existing code keeps compiling. At runtime, `promptTokens` and `totalTokens` are higher on Anthropic calls that read the prompt cache, in `onUsage`, the `'usage'` event and OpenTelemetry's `gen_ai.usage.input_tokens`. Code that added cache reads to `promptTokens` by hand now counts them twice. See [Migration Notes](/docs/migration-notes#300-prompttokens-includes-cache-reads-and-writes).
