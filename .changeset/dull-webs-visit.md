---
'vern-llm': minor
---

Fixed several gaps in streaming (`stream: true`).

Added a `chunkIdleTimeoutMs` option (default 30000ms, `0` disables it) that bounds the gap between chunks after the first. Previously only stream-open and the first chunk were bounded by `timeoutMs`, so a connection that streamed one chunk then hung would never fail. An idle-timeout failure now also trips the circuit breaker, unlike other mid-stream failures, since a provider that reliably streams one chunk then hangs would otherwise never trip it.

Added `complete?: boolean` to `StreamChunk`/`WireStreamChunk`'s `tool_call_delta` variant. Gemini always delivers a `functionCall`'s arguments whole in one chunk, indistinguishable before now from a genuine fragment from other providers. Gemini's adapter and cache-replay chunks (`buildReplayChunks`) now set it.

Chunk buffer eviction is now logged at debug level when a caller doesn't read `chunks` (or falls far behind), so missing chunks in a reconstructed stream can be traced back to eviction instead of looking like a transport bug.

Added a `ping` variant to `WireStreamChunk` for provider keep-alive signals with no content. `fromFetch` (SSE comment-line pings, via a new exported `SSE_PING` sentinel) and `fromAnthropic` (Anthropic's documented `ping` events) both recognize these and reset the idle timer, instead of silently dropping them and risking a timeout on an actively alive long-running stream.

This is purely additive. Existing callers, and adapters that don't emit `ping` or set `complete`, are unaffected.
