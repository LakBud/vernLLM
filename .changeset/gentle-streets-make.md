---
'vern-llm': minor
---

Add `runsAfter`/`runsBefore` and `position` to `VernLLMMiddleware` for composing middleware from more than one source without every author agreeing on the same `priority` numbers ahead of time.

`runsAfter`/`runsBefore` reference another entry's `name` and resolve into `transform`/`onEvent` order alongside `priority`; a referenced name that isn't registered is dropped with a warning, and a cycle throws at `VernLLM` construction time naming every middleware in the cycle. `position: 'outermost' | 'innermost' | number` pins a middleware's slot in `wrap` nesting independently of `transform`/`onEvent` order, so a middleware like a billing meter can guarantee it sees the net `CallResult` of every retry and fallback target regardless of what else gets registered later.

Every hook's `ctx` now also carries `registeredMiddlewareNames`, every registered middleware's resolved label, so a middleware can detect another one by name (e.g. skip a duplicate action) without coordinating at registration time.

A priority-only setup keeps its exact current order; this also fixes an internal bug where `applyMiddlewareTransforms` re-sorted an already-ordered middleware array a second time, which was harmless while ordering was a flat `priority` sort but would have silently diverged from `wrap`'s own ordering once `runsAfter`/`runsBefore`/`position` were introduced. Order is now decided once, at construction time, in a single `MiddlewarePipeline`, and every consumer (`transform`, `wrap`, `onEvent`, context construction) reads the one view it needs off that instead of re-deriving it.
