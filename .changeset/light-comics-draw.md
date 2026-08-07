---
'vern-llm': minor
---

Added streaming support to `fromFetch` via three new `FetchAdapterConfig` fields: `requestStream`, `parseStreamFrames`, and `mapStreamEvent`. `mapStreamEvent` is required for `stream: true` calls; omitting it throws `LLMError('validation')`.

`fromOpenAICompatible` and its aliases now gate `stream_options.include_usage` behind a new `supportsStreamUsage` option, defaulting to `true`. Verified against provider docs for `Groq`, `DeepSeek`, `Mistral`, `Perplexity`, and `LM Studio`. Pass `supportsStreamUsage: false` for a provider confirmed not to support it.
