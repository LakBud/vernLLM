---
'vern-llm': minor
---

`CallResult` gains `cache?: 'hit' | 'join'`, set by `cachedCall()` when no call of its own ran, so a middleware can tell a stored value from a shared in flight call.

A streamed join returns before the shared call has answered, so its `meta` is still unset when `next()` returns and it looked like a hit. `cache` is decided when the cache is read, so it is known at once, for streams too.

Existing code keeps compiling and behaving the same: the field is optional and only `cachedCall()` sets it.
