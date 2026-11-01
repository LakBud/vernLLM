---
'vern-llm-bedrock': patch
---

`fromBedrock` reports a `stopReason` of `guardrail_intervened`, `content_filtered` or `refusal` as a provider refusal, so a response with no content fails once as `model_refused` instead of retrying and falling back.

Streams do the same on `messageStop`. A guardrail's canned message, which arrives as content, is still returned as an answer. The fix needs `vern-llm` 3.1.0 or later, since older cores ignore the new `refusal` field and keep failing as `empty_response`.
