---
'vern-llm': patch
---

Coalescing, abort, and deadline fixes.

One caller's abort or deadline no longer fails every coalesced `cachedCall`. The shared request is aborted only once every caller has left.
A joiner's own abort rejects it right away, instead of waiting for the trigger to settle.
`deadlineMs: Infinity` means no deadline, instead of aborting after about 1ms. NaN and values past the timer range are treated the same way.
