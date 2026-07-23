---
'vern-llm': minor
---

Make `CallParams.systemPrompt` optional and omit system messages when unset.
Export `AnthropicClient`, `GeminiClient`, and `BedrockConverseClient` as public types.
Add an `adapters` barrel export for provider adapters.
Refactor internal types into focused modules while preserving the existing public API.
Add regression and integration test coverage for optional system prompts and adapter behavior.
Add Anthropic adapter coverage to verify provider payloads omit `system` when `systemPrompt` is not provided.
Add cache adapter test coverage for custom adapter support and cache failure handling.
Bump the minor version to reflect new public API exports.
