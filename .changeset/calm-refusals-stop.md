---
'vern-llm': minor
---

A provider refusal with no content now fails once as `LLMError('invalid_params')` with the code `model_refused`, instead of retrying and falling back.

OpenAI returns a refusal as `message.refusal` with `content: null`, which used to throw the retryable `empty_response`. The call was billed again, then answered by a fallback provider. `model_refused` is never retried, never counts toward the breaker and does not fall back by default. The refused attempt's tokens are reported as a usage failure. To fail over on a refusal, return `'next'` from `fallbackOn` for that code.

What counts as a refusal, in each adapter:

- OpenAI compatible: `message.refusal`, or `delta.refusal` on a stream.
- `fromAnthropic`: `stop_reason: 'refusal'`.
- `fromFetch`: `refusal` from `mapResponse`, or a `{ type: 'refusal' }` chunk from `mapStreamEvent`.
- `fromGemini`: a candidate `finishReason` of `SAFETY`, `BLOCKLIST`, `PROHIBITED_CONTENT` or `SPII`, and a blocked prompt (any `promptFeedback.blockReason` but `BLOCKED_REASON_UNSPECIFIED`). `RECITATION`, `LANGUAGE` and `OTHER` finishes are not mapped and still fail as `empty_response`.

`LLMClient` responses gain an optional `message.refusal`, and `WireStreamChunk` gains `{ type: 'refusal'; delta?: string }`, which is never surfaced to callers. A `switch` over `WireStreamChunk` with no default may stop compiling. On a stream the error reaches `chunks` and `finalResult`, not the `call()` promise. A partial answer that ends in a refusal is returned as before, and text refusals and empty responses with no `refusal` are unchanged.
