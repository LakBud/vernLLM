---
'vern-llm-otel': minor
---

Add `endAttributes` and `otelLogFields`.

`endAttributes(ctx)` adds attributes to the call span when it ends, after `finalResult` settles for a stream, so values only known at the end, such as a cost, can go on it. It is guarded and sanitized like `attributes`, and applied before the package's own end attributes, so it can never replace a `vernllm.*` or `gen_ai.*` one.

`otelLogFields(ctx)` returns the call span's `traceId` and `spanId`, or `{}` when there is no valid span, for a log record to carry. It works with either middleware registered first.
