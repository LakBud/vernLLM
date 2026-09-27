---
'vern-llm-otel': minor
---

Attempt spans now follow the provider request, and time to first chunk skips keep-alive pings. Needs `vern-llm` 3.0.0.

An attempt span starts when the request is sent, after the rate limiter and every `transform`, and is the active span while it runs, so an HTTP client span nests under it. Its duration no longer includes rate limit waiting or later transforms. A call rejected before sending, by an open circuit, a full rate limit queue, a throwing `transform`, or a capability the model lacks, gets no attempt span, no duration point, and no count in `vernllm.total_attempts`.

Time to first chunk runs from sending the request to the first content chunk. Pings, including those Claude sends while reasoning, no longer count, so reasoning models report a later, accurate value.

`gen_ai.provider.name` uses the provider the adapter names before guessing from the model id. `providerNames` still wins.

Input capture reads the request as sent, after every `transform`, so it is never skipped for ordering and `vernllm.content.skipped_reason` is gone. The default `priority` is `-1000` whether or not capture is on.

Existing code keeps compiling. At runtime, dashboards see shorter attempt spans, fewer attempt spans, and later time to first chunk values for streams that ping first.
