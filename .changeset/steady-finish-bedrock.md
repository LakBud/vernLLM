---
'vern-llm-bedrock': patch
---

The adapter reports every `stopReason` as a finish reason, not only `max_tokens`: `end_turn` and `stop_sequence` as `stop`, `tool_use` as `tool_calls`, `guardrail_intervened` as `guardrail`, `content_filtered` as `content_filter`, and `refusal` as `refusal`. On a stream it also yields a `finish` chunk. With `vern-llm` setting `CallMeta.finishReason`, a guardrail that stops an answer after text came back is visible to the caller.
