---
'vern-llm': minor
---

Middleware can report its own events with `ctx.emit`, delivered as a new `'custom'` event.

```ts
wrap: async (request, next, ctx) => {
  ctx.emit('router.decision', { deployment: 'claude', strategy: 'weighted' });
  return next();
};
```

The event carries `requestId`, `name`, the emitting middleware's label as `source`, and optional JSON `data`. It reaches `onEvent` and every enabled middleware's `onEvent`, the emitter included. VernLLM sets no meaning for `name` or `data`, so a router, policy layer, or cost tracker owns its own. `ctx.emit` never throws: an empty name or data that isn't plain JSON is dropped with one warning per call, an emit made from inside a `'custom'` handler is dropped, and a call delivers at most 100 custom events.

Existing code keeps compiling unless it has an exhaustive `switch` over `VernLLMEvent['kind']`, which needs a case for `custom`, or builds `AttemptContext`/`PreDispatchContext` objects by hand, which need `emit`. At runtime nothing changes until a middleware calls `ctx.emit`.
