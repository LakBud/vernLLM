---
'vern-llm': minor
---

`call()` and `cachedCall()` now accept an optional `deadlineMs`, a total time budget for the whole logical call spanning every retry and every fallback target, unlike `timeoutMs` which resets on each attempt. Once `deadlineMs` elapses, the call is aborted with `LLMError('aborted', { code: 'deadline_exceeded' })`, distinguishable from an abort caused by a caller-supplied `signal`. Purely additive: omitting `deadlineMs` leaves existing behavior unchanged.
