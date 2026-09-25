# vern-llm-otel

## 0.1.1

### Patch Changes

- 8846fbb: Telemetry fixes.

  `gen_ai.provider.name` no longer uses the target label. Unmapped targets are inferred from the model id (Claude with an `@version` suffix is `gcp.vertex_ai`), and `_OTHER` is used when that fails. Dashboards filtering on `primary` or `fallback[0]` need updating, or set `providerNames`.
  Input capture is skipped when any middleware sorts after it, so a later redactor can never be bypassed. The span gets `vernllm.content.skipped_reason` and a warning is logged once. Middleware without a `transform` counts too, so give `otelMiddleware` the highest priority when capturing.
  `maxLength` now caps the whole attribute, JSON and marker included. Older messages that don't fit are dropped whole, not left as marker only parts. An attribute whose structure alone doesn't fit is left out instead of exceeding the limit.
  The `normalizeModel` cache is bounded.
  `gen_ai.request.temperature` is omitted for Anthropic, and for Claude on Bedrock, when thinking is on, since it is never sent.
  An attempt whose closing signal was missed ends with `vernllm.attempt.outcome` set to `unknown` instead of an error, and records no duration.

- Updated dependencies [8ae597d]
- Updated dependencies [5b4858c]
- Updated dependencies [d02c2a7]
- Updated dependencies [c45a708]
- Updated dependencies [c417a00]
  - vern-llm@2.10.0

## 0.1.0

### Minor Changes

- b0926d9: Add `vern-llm-otel`, an optional OpenTelemetry integration for `vern-llm`. One middleware turns every call into traces and metrics that follow the GenAI semantic conventions, and it uses only the public middleware system, so nothing about `vern-llm` itself changes.

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

### Patch Changes

- Updated dependencies [b6b1400]
- Updated dependencies [2de140f]
- Updated dependencies [7277ee1]
- Updated dependencies [0187299]
- Updated dependencies [00b1c0f]
- Updated dependencies [abac0fb]
  - vern-llm@2.9.0
