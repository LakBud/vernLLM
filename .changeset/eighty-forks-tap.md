---
'vern-llm': patch
---

Deliver a middleware's `onEvent` synchronously, before the code that emitted the event continues.

Handlers of a middleware with no `enabled` function, or a boolean one, now run in registration order in the same tick as the event. A `'usage'` event has therefore arrived before the code after `await next()` in `wrap` runs, and before a stream's `finalResult` settles. Previously each handler ran after an awaited `enabled` check, so a middleware relying on `'usage'` to finish its work could be called after the call had already returned.

A function `enabled` is now resolved independently per middleware. A slow predicate on one middleware no longer delays the `onEvent` of the middleware after it.

What to expect:

1. A handler can observe state before the emitting code's next line runs.
2. A slow synchronous handler delays the emitting call path when `enabled` is static or absent, so keep handlers fast. It always did, only later. A handler behind a function `enabled` runs asynchronously and does not delay it.
3. A handler that calls `llm.call()` is fine and cannot deadlock.
4. A throwing or rejecting handler is still logged and never affects the call.
