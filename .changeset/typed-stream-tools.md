---
'vern-llm': patch
---

Improve TypeScript inference for calls that combine `jsonMode: false` with conditional `tools`.
`call()` and `cachedCall()`, with or without `stream: true`, now infer string content for the
non-tool result without requiring an explicit response type, while preserving the wrapped content
and tool-call result union when tools are present.

The conditional string-tool parameter shapes are exposed as named helper types for reuse:
`ConditionalStringToolCallParams`, `CachedConditionalStringToolCallParams`,
`StreamConditionalStringToolCallParams`, and `CachedStreamConditionalStringToolCallParams`.
