---
'vern-llm': minor
---

Add `logger: 'silent'` shorthand to `VernLLMOptions`, backed by an internal no-op logger. Silencing all output no longer requires stubbing `debug`, `warn`, and `error` yourself.

Also improved internal log message consistency. Every "hook failed" log (`onEvent`, `onUsage`, `onUsageFailure`, `circuitBreaker.onStateChange`, and labeled middleware hooks) now goes through a shared `logHookError` helper, always includes the error's `stack` alongside `message`, and uses the same `[VernLLM] <hook> failed` shape. Fixed a `detectSoftFailure` warning that was missing the `[VernLLM]` prefix. The debug output line for a call's raw response now appends a truncation notice with the full character count when the logged content is cut off, instead of silently dropping the rest.
