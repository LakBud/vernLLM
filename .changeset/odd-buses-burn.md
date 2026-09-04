---
'vern-llm': patch
---

Add `isStreamResult()`, a runtime check for whether a `call()` result is a `StreamCallResult`, mirroring the existing `isToolCallResult()`. Useful when `stream` was computed conditionally: `call()`'s overloads only pick the streaming return type for a literal `stream: true` at the call site, so a conditionally-set `stream` still needs a manual cast to access `chunks`/`finalResult` safely, `isStreamResult()` narrows that cast instead of trusting it blindly.
