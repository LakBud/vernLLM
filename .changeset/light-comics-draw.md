---
'vern-llm': minor
---

Added streaming support to the generic `fromFetch` adapter.

Three new optional `FetchAdapterConfig` fields wire up streaming for any OpenAI-compatible-shaped HTTP endpoint: `requestStream` opens the streaming HTTP request (defaults to native `fetch`), `parseStreamFrames` splits the raw response bytes into individual event payloads (defaults to Server-Sent Events framing), and `mapStreamEvent` maps one parsed event into zero, one, or more `WireStreamChunk`s. `mapStreamEvent` is required for `stream: true` calls; a config that omits it now throws a clear `LLMError('validation')` instead of failing silently or confusingly mid-stream.

Also fixed a related correctness bug: `fromOpenAICompatible` and its aliases previously sent `stream_options: { include_usage: true }` unconditionally on every streamed call. Not every OpenAI-compatible provider supports that field, so a provider that rejects unrecognized parameters could fail every streamed call outright, which is what Mistral used to do. `stream_options` is now gated behind a new `supportsStreamUsage` adapter option, defaulting to `true`. This default was verified directly against provider docs for Groq, DeepSeek, Mistral, Perplexity, and LM Studio, all of which support the field, so existing callers keep getting usage in their stream exactly as before. Pass `{ supportsStreamUsage: false }` only for a provider you've confirmed rejects it.

This is purely additive. Existing `fromFetch` configs without the new streaming fields, and existing OpenAI-compatible aliases, are unaffected.
