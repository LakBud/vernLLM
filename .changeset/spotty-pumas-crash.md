---
'vern-llm': patch
---

A `dispatch` hook's `next()` settles at a stream's first content chunk instead of its first keep-alive ping.

A stream that fails after a ping but before content now rejects `next()` with that attempt's error, so a hook timing or tracing the provider request sees the same outcome the retry loop does. `call()` still resolves on the first ping.

Existing code keeps compiling. At runtime only `dispatch` hooks on streams see a change: `next()` settles later when the provider sends pings first.
