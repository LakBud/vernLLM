---
'vern-llm': minor
---

Middleware `ctx` carries three read only facts about how the call started: `streaming`, `callTargets` and `deadlineAt`.

`ctx.streaming` is whether the call asked for a stream. `ctx.callTargets` is the call's own `targets`, a frozen copy, when it passed one, and an order another middleware passes to `next({ targets })` never changes it. `ctx.deadlineAt` is when the call's `deadlineMs` runs out, in epoch milliseconds, and is absent without a deadline.

All three are optional and read the same way `ctx.context` is, in every hook, stage and fallback attempt. For `cachedCall`, each caller's `deadlineAt` comes from its own `deadlineMs`.
