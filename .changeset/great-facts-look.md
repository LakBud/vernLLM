---
'vern-llm-bedrock': minor
---

`promptTokens` now includes cache reads and writes, and the cache split is reported on `TokenUsage`.

`fromBedrock` adds `cacheReadInputTokens` and `cacheWriteInputTokens` to Converse's `inputTokens`, which excludes them. Before, `promptTokens` plus `completionTokens` fell short of Bedrock's `totalTokens` whenever prompt caching was on. Now they agree, and `totalTokens` is still what Bedrock reports. `TokenUsage` gains `cacheReadTokens`, `cacheWriteTokens` and `cacheWriteTokensByTtl`, the last read from `cacheDetails` and keyed by its TTL label.

```ts
// Before: inputTokens alone
usage.promptTokens; // 10

// After: inputTokens plus cache reads and writes
usage.promptTokens; // 10010
usage.cacheReadTokens; // 8000
usage.cacheWriteTokens; // 2000
```

Existing code keeps compiling. At runtime, `promptTokens` is higher on calls that use the prompt cache, in `onUsage`, the `'usage'` event and OpenTelemetry's `gen_ai.usage.input_tokens`. The token rate limiter is unchanged, since Bedrock's total already included cache tokens. See [Migration Notes](/docs/migration-notes#300-prompttokens-includes-cache-reads-and-writes).
