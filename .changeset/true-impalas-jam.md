---
'vern-llm-otel': patch
---

Telemetry fixes.

`gen_ai.provider.name` no longer uses the target label. Unmapped targets are inferred from the model id (Claude with an `@version` suffix is `gcp.vertex_ai`), and `_OTHER` is used when that fails. Dashboards filtering on `primary` or `fallback[0]` need updating, or set `providerNames`.
Input capture is skipped when any middleware sorts after it, so a later redactor can never be bypassed. The span gets `vernllm.content.skipped_reason` and a warning is logged once. Middleware without a `transform` counts too, so give `otelMiddleware` the highest priority when capturing.
`maxLength` now caps the whole attribute, JSON and marker included. Older messages that don't fit are dropped whole, not left as marker only parts. An attribute whose structure alone doesn't fit is left out instead of exceeding the limit.
The `normalizeModel` cache is bounded.
`gen_ai.request.temperature` is omitted for Anthropic, and for Claude on Bedrock, when thinking is on, since it is never sent.
An attempt whose closing signal was missed ends with `vernllm.attempt.outcome` set to `unknown` instead of an error, and records no duration.
