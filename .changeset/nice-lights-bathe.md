---
'vern-llm': minor
---

Add multimodal input support through `userContent`.

`userContent` now accepts either a plain string or a `ContentBlock[]` array containing text and image
blocks. Existing string-based calls continue to work unchanged.

Image blocks are translated automatically by provider adapters:

- OpenAI-compatible providers pass through native multimodal content.
- Anthropic converts image blocks to image source blocks.
- Gemini converts image blocks to inline data parts.
- AWS Bedrock converts image blocks to Converse image content blocks.

This enables sending images alongside text while keeping the existing text-only API backwards
compatible.
