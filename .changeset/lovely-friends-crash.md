---
'vern-llm': minor
---

Reworked the `LLMError` taxonomy so `type` stays a small, closed set a caller can exhaustively `switch` over, while `code` carries the specific reason underneath it. This is a breaking change to several already-shipped `type`/`code` values, accepted on minor since `vern-llm` is still in beta:

- Tool contract failures (`unknown_tool`, `duplicate_tool_call_id`, `tool_choice_none_violated`, and the previously uncoded "provider returned `tool_calls` with no `tools` sent" case, now `code: 'unexpected_tool_calls'`) move from `type: 'api'` to `type: 'validation'`. They're a provider contract violation, not an HTTP failure.
- A new `type: 'invalid_params'` splits off from `type: 'validation'` for every check that's deterministic on the caller's own input and never touches the network: the `requestBuilder.ts` checks (empty/duplicate tools, `toolChoice` issues, schema/`jsonMode` conflicts, history ordering), the `cachedCall` `reserveUsage`/`refundUsage` guard, `imageFormat.ts`'s mimeType check, and "no provider targets configured." A new `code: 'unsupported_capability'` covers the one pattern repeated across adapters: `stream: true` against a client with no streaming method, a model outside `toolUseSupportedModels`, or `toolChoice: 'none'` against a provider with no equivalent.
- Local rate-limit rejections move from `type: 'quota_exceeded'`, `code: 'local_rate_limit'` to `type: 'rate_limited'`, split into three specific codes: `rate_limit_queue_full`, `rate_limit_queue_timeout`, and `rate_limit_capacity_exceeded`. The old single code couldn't tell a caller whether waiting and retrying later was worth attempting; `rate_limit_capacity_exceeded` never will, the other two usually will once load drops. `type: 'quota_exceeded'` now means only what it originally described: a `reserveUsage` hook rejecting the call.
- `code: 'invalid_credentials'` is replaced by `authentication` (401) and `authorization` (403), so a caller can tell a missing key apart from a key that lacks access without VernLLM inventing a new `type` for every HTTP status. New codes `not_found` (404), `payload_too_large` (413), `server_error` (5xx), and `empty_response` round out the HTTP-status-derived set.
- A new `type: 'network'` with `code: 'connection_failed'` separates transport-level failures (DNS, connection refused, connection reset) from the catch-all `type: 'unknown'`.
- `FallbackExhaustedError.type` is now always `'fallback_exhausted'`, its own identity, instead of inheriting the last attempted target's `type`. `status` and `retryAfterMs` still inherit from the last attempt.

Added `LLMError.retryable`, computed purely from `type`/`code`, independent of any specific call's `nonRetryableStatus` list or its signal's abort state. `FallbackExhaustedError` overrides it to defer to the last attempted target's own `retryable`, since `type: 'fallback_exhausted'` alone carries no retry signal.

`LLMError`'s constructor collapses everything after `type` into one optional object: `new LLMError(message, type, { status, code, issues, cause, retryAfterMs })`. Previously these were five more positional parameters, so a throw site that only needed `code` still had to write four `undefined`s to reach it. This breaks any `new LLMError(...)` call site outside the package itself, including a custom `LLMClient` adapter or a subclass calling `super()` positionally — narrower than it sounds, since callers normally only catch `LLMError`, not construct it, but worth naming directly: the last time this constructor grew, the explicit goal was that every existing call site would keep compiling unchanged, and this change knowingly reverses that.

Removed the deprecated `toolIssues` getter/setter on `LLMError`. `issues` is now the only place tool contract problems (or a schema validator's error object) are carried; read `error.issues` instead of `error.toolIssues`.

`LLMError.retryable` now also returns `false` for `type: 'aborted'`, matching the taxonomy's own type table (previously an aborted error would report `retryable: true`, which contradicted intentional-cancellation semantics). `CallExecutor`'s internal retry/circuit-breaker accounting is unaffected, since an aborted signal was already checked separately before either ever consulted `retryable`.

`issues` gained real types instead of being blanket `unknown`. `LLMErrorIssuesByCode` maps every code that carries structured data to its exact shape, and a new `hasIssues(err, code)` type guard narrows `err.issues` off that same `code` with no manual cast:

```ts
if (isLLMError(err) && hasIssues(err, 'duplicate_tool_names')) {
  console.log(err.issues.names); // string[], fully typed
}
```

Five new codes back this: `duplicate_tool_names` and `unknown_tool_choice` (both `requestBuilder.ts` checks that previously threw uncoded), and `duplicate_tool_result_ids`/`unknown_tool_result_ids`/`missing_tool_results` (the three `history` "tool" turn checks, also previously uncoded). All five, plus the existing `unsupported_capability`, now carry a typed `issues` payload built from the same list the `message` already string-joins, rather than making a caller re-parse it out of prose. `unknown_tool`/`duplicate_tool_call_id` (`ToolIssue[]`) are unchanged, just added to the same lookup table. Every other `invalid_params` check stays uncoded and without `issues`, since it's a single deterministic fact the `message` already states in full. Schema-validation failures (`type: 'validation'`, no `code`) are the one deliberate exception left as `unknown`: that payload is the caller's own Zod-compatible validator's error object, a shape VernLLM can't know in advance.
