---
'vern-llm': patch
---

Two type-only additions from the CallExecutor refactor plan, no behavior change.

Added `metaRef()`, a small helper that returns `{}` typed as `{ current?: CallMeta }`, for use as
`CallParams['meta']`. Saves writing that type out by hand when reading the target that answered
off `call()`'s `meta` out-parameter. A hand-written `{ current?: CallMeta }` literal still works
exactly the same.

Added `LLMRequestShape<T, Tools>`, the request-only fields a call takes, without the
`reserveUsage`/`refundUsage` hooks from `UsageHooks`. `CallParams<T, Tools>` is now defined as
`LLMRequestShape<T, Tools> & UsageHooks`, and `CachedCallParams`, `CachedToolCallParams`,
`CachedConditionalToolCallParams`, `CachedJsonModeDisabledCallParams`,
`CachedJsonModeEnabledCallParams`, `CachedStreamCallParams`, `CachedStreamToolCallParams`,
`CachedStreamConditionalToolCallParams`, `CachedStreamJsonModeDisabledCallParams`, and
`CachedStreamJsonModeEnabledCallParams` are now derived from `LLMRequestShape` directly instead of
each separately re-deriving `Omit<CallParams<T>, 'reserveUsage' | 'refundUsage'>`. No field on any
of these types changes shape; `LLMRequestShape` is also exported for anyone who wants the request
shape on its own.
