---
'vern-llm': minor
---

`CallMeta.finishReason` says why the answering target stopped: `stop`, `length`, `tool_calls`, `refusal`, `guardrail`, `content_filter` or `other`. A call that returns text does not throw when a provider stops early, so this is how a caller tells a complete answer from one cut off by a filter, a guardrail or the output limit. It is set for every adapter that reports a reason, and for a stream once `finalResult` resolves. It is absent on a cache hit. Nothing about retries, fallback or errors changes.

Per adapter: OpenAI compatible reads `finish_reason`, on streams too, and reports a refusal that came with text as `refusal`. `fromAnthropic` maps `stop_reason`, `fromGemini` maps the candidate `finishReason` (the safety reasons are `content_filter`), and `fromFetch` takes `finishReason` from `mapResponse` or a `{ type: 'finish', reason }` chunk from `mapStreamEvent`.

`LLMClient` responses read `finish_reason` as before, but adapters now send every reason, not only `length`. `WireStreamChunk` gains `{ type: 'finish'; reason: string }`, which is never surfaced to callers. A `switch` over `WireStreamChunk` with no default may stop compiling.
