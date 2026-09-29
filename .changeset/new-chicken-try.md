---
'vern-llm': minor
---

A call takes a `context`, plain JSON that middleware, events and usage carry.

```ts
await llm.call({
  userContent,
  context: { tenantId: 't1', routing: { only: ['bedrock'] } },
});
```

Middleware reads it as `ctx.context` in every hook and stage, fallback attempts included. Every event the call reports has it as `event.context`, and so does the `TokenUsage` in `onUsage` and the `'usage'` event, so a cost middleware can attribute spend to a tenant. It is a frozen copy made when the call starts, is never sent to the provider, and is not part of the `cachedCall` cache key. VernLLM defines no keys: whatever is built on it owns its own.

Anything that isn't a plain JSON object throws `LLMError` of type `invalid_params` with the new code `invalid_context`, before any hook runs or request is sent.

Existing code keeps compiling unless it has an exhaustive `switch` over `LLMErrorCode`, which needs a case for `invalid_context`, or builds `AttemptContext`/`PreDispatchContext` objects by hand, which need `context`. At runtime nothing changes until a call passes `context`.
