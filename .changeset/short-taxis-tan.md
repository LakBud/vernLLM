---
'vern-llm': minor
---

Added a `call()` overload for `toolChoice: 'none'`, narrowing the return type to `ContentResult<T>`
instead of the full `CallWithToolsResult<T>` union, since the model is structurally barred from
returning a `tool_calls` result in that case.

Also tightened `cachedCall`: `reserveUsage`/`refundUsage` no longer type-check inside the nested
`call` object on `CachedCallParams`/`CachedToolCallParams`/`CachedStreamCallParams`/
`CachedStreamToolCallParams`, they belong at the top level alongside `cacheKey`/`ttl`. A caller that
bypasses the type system and sets them inside `call` anyway now gets `LLMError('validation')`
instead of a runtime warning and silent no-op.
