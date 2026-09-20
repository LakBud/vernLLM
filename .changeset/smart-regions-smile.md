---
'vern-llm-otel': minor
---

Add `vern-llm-otel`, an optional OpenTelemetry integration for `vern-llm`. One middleware turns every call into traces and metrics that follow the GenAI semantic conventions, and it uses only the public middleware system, so nothing about `vern-llm` itself changes.

Each call becomes a `vernllm.call` span with one `chat {model}` span per attempt underneath, so every retry and fallback is visible. Token usage, duration, and time to first chunk are recorded as the `gen_ai.client.*` metrics, and retries, fallbacks, rate limit waits, and circuit breaker transitions are recorded as `vernllm.*` counters and histograms. Prompts and responses are never recorded unless you turn on `captureContent`, which supports `redact`, `maxLength`, and a per call `when` gate.

```ts
import { VernLLM } from 'vern-llm';
import { otelMiddleware } from 'vern-llm-otel';

const llm = new VernLLM({
  client,
  model: 'gpt-4o',
  middleware: [otelMiddleware({ providerNames: { primary: 'openai' } })],
});
```

`vern-llm` and `@opentelemetry/api` are peer dependencies, and the package registers nothing globally: it uses whichever SDK your app has started. Streams are observed without touching `chunks` or `finalResult`. The GenAI semantic conventions are in Development status, so attribute and metric names can change in a later release.

New package, first release.
