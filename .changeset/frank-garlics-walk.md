---
'vern-llm': minor
---

Added observability events, provider labeling, and fixed a tool-contract retry defect.

`VernLLMOptions.onEvent` reports `'retry'` and `'circuit_state'` events as they happen. Fire-and-forget, mirroring the existing `onUsage` pattern exactly: a throwing handler is caught and logged, its return value is never read, and it can only ever change what gets reported, never what the call does.

`VernLLMOptions.name` (default `'primary'`) labels a `VernLLM` instance. It's threaded into `TokenUsage.provider` and every emitted event, so a shared `onEvent`/`onUsage` handler can tell multiple instances apart. This also lays the groundwork for multi-target fallback in a future release.

`CircuitBreaker` was refactored so every state mutation routes through a single `transition()` method, guaranteeing `onStateChange` (and now `onEvent`'s `'circuit_state'`) fires exactly once per real transition, never on a no-op like open to open. `assertClosed`/`recordSuccess`/`recordFailure` now accept an optional `model` param, reported on the transition it triggers; the breaker's failure counting is unchanged, still shared-fate across models by default, so this only affects what's reported, not when the circuit opens or closes.

Both the `'retry'`/`'circuit_state'` events and the breaker's `assertClosed` gate now use the model actually resolved for that call (honoring a per-call `model` override) instead of always the instance default.

Fixed `validateToolCallArguments`: an unknown tool name or a duplicate tool-call id was previously classified `type: 'api'` with no distinguishing code, which meant `shouldRetry` treated it as retryable, burning the whole retry budget on a request that was guaranteed to fail identically every time (the wire request doesn't change between attempts). These failures now carry `code: 'unknown_tool'` or `code: 'duplicate_tool_call_id'` (still `type: 'api'`, so no existing type check breaks) and are excluded from retry. Every such issue in a response is now aggregated into one error's `toolIssues: ToolIssue[]`, instead of throwing on the first and hiding the rest. Schema-validation failures are unchanged: still a separate pass, still `type: 'validation'`, still first-failure-only.

`LLMError` gains two new optional, additive fields: `code: LLMErrorCode` and `toolIssues?: ToolIssue[]`. Both are appended as the last positional constructor params, so every existing `new LLMError(...)` call site keeps compiling unchanged.
