---
'vern-llm': minor
---

Adds middleware support via a new `middleware` option on `VernLLMOptions`. Each entry can `transform` the outgoing wire request per attempt (patches, not full replacement; `addMessages`/`addTools` append without clobbering another middleware's own additions), `wrap` one whole logical call exactly once regardless of how many retries or fallback targets ran underneath it (with the ability to short-circuit the real call entirely), observe the same events reported on `onEvent` via its own `onEvent`, and gate itself per call via `enabled`. `wrap` and `transform` compose across several middleware in `priority` order, and can coordinate through a typed, collision-proof `ctx.state` (see the new `createStateKey`). A new `createMiddleware` helper adds an `onError` convenience on top of `wrap` for the common "I only care about failures" case. A new `middlewareTimeoutMs` option (default 5000) bounds `transform` and a function `enabled`; values `<= 0` disable the timeout (unbounded). `wrap` itself is intentionally never bounded by it, since it legitimately spans the whole call.

Purely additive: `middleware` defaults to an empty array, and no existing option, method, or type changes shape.
