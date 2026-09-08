---
'vern-llm': minor
---

Add `MiddlewareRef` and `createMiddlewareRef` for `runsAfter`/`runsBefore`.

`runsAfter`/`runsBefore` now take a `MiddlewareRef` instead of a `name` string. Create one with `createMiddlewareRef`, attach it to a middleware via `ref`, and have a dependent import the same reference to target it. A typo or a stale copy simply fails to resolve, since matching is by object identity, not string equality.

`name` is unchanged. It still sets a middleware's log label and the `'middleware'` event's display name; it plays no role in ordering.

This is a breaking change for `runsAfter`/`runsBefore` only. Existing string values there need to become `MiddlewareRef`s. `name`, `priority`, and `position` are unaffected.
