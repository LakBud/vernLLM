---
'vern-llm-otel': minor
---

Cache token attributes and custom span events. Needs `vern-llm` 3.0.0.

Attempt spans set `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_write.input_tokens` when the provider reports them. Both are subsets of `gen_ai.usage.input_tokens`, as the GenAI conventions define. The token usage metric still records input and output only.

Each event a middleware reports through `ctx.emit` becomes a span event on the call span, named after the event, with `vernllm.event.source`. The event's `data` is whatever the middleware passed, so it is left out unless you opt in, and no metric is recorded for custom events.

```ts
otelMiddleware({ customEvents: { data: true, maxLength: 2048 } }); // default: on, no data
otelMiddleware({ customEvents: false }); // record none
```

Existing code keeps compiling. At runtime, spans gain the two cache attributes on calls that use the prompt cache, and a call whose middleware emits events gains span events. Set `customEvents: false` to keep spans as they were.
