---
'vern-llm': minor
---

Added a `call()` overload for `toolChoice: 'none'`, narrowing the return type to `ContentResult<T>`
instead of the full `CallWithToolsResult<T>` union, since the model is structurally barred from
returning a `tool_calls` result in that case. This can change the inferred return type at existing
call sites that already pass `tools` with `toolChoice: 'none'`: code that defensively checked
`isToolCallResult(result)` or accessed `result.toolCalls` there will now see a type error, since
`toolCalls` isn't a field on `ContentResult<T>`.

The `ContentResult<T>` guarantee is now also enforced at runtime: if a provider (or a custom
adapter) returns `tool_calls` anyway despite `toolChoice: 'none'`, `call()` throws
`LLMError('api')` instead of silently returning a `{ type: 'tool_calls', ... }` result that would
contradict the narrowed type.

Also tightened `cachedCall`: `reserveUsage`/`refundUsage` no longer type-check inside the nested
`call` object on `CachedCallParams`/`CachedToolCallParams`/`CachedStreamCallParams`/
`CachedStreamToolCallParams`, they belong at the top level alongside `cacheKey`/`ttl`. A caller that
bypasses the type system and sets them inside `call` anyway now gets `LLMError('validation')`
instead of a runtime warning and silent no-op.
