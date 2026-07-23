---
'vern-llm': minor
---

Make `CallParams.systemPrompt` optional (omit system message when unset), export `AnthropicClient`, `GeminiClient`, and `BedrockConverseClient`, add an `adapters` barrel export, refactor internal types into focused modules with no public API changes, add test coverage, and bump minor due to new public API exports.
