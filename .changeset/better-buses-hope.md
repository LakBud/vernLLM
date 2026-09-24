---
'vern-llm': patch
---

Streaming fixes.

A rate-limit hint that arrives before the first real chunk no longer counts as the stream having opened, so a failure on that first chunk is retried and can fall back.
A slow reader of `chunks` pauses the stream instead of silently losing chunks. Eviction now only applies while nobody is reading, such as before the first read or after a `break`.
SSE parsing runs in linear time on large frames split across many chunks.
