---
'vern-llm': patch
---

Add a `call()` overload for conditional `stream` (e.g. `stream: someCondition`). Previously this fell through to the non-streaming `Promise<T>` overload and silently mistyped the result whenever `stream` evaluated to `true` at runtime. `call()` now returns the honest `T | StreamCallResult<T>` union for a genuinely conditional `stream` value, matching how conditional `tools` already works. Adds `isStreamResult()` for narrowing the result at runtime, mirroring `isToolCallResult()`. A literal `stream: true` is unaffected and keeps resolving through the existing overloads, as is a literal `stream: false` on its own. Combining a literal `stream: false` with an explicit `call<T>()` type argument over-widens to the union instead of narrowing to `T`, a known TypeScript inference limitation, see the streaming docs.
