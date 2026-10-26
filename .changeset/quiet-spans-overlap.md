---
'vern-llm-otel': minor
---

Calls with more than one chain get one attempt span per chain.

A middleware that reruns the rest of the pipeline with `next.again()` runs attempts side by side. Each chain now tracks its own current attempt, so a second chain no longer closes the first one's span as abandoned. The attempt that answers keeps its usage, outcome and status, the attempts that were cancelled end with `vernllm.attempt.outcome: "unknown"`, and the attempt duration metrics include the answering attempt. Events carry their chain, so retries, fallbacks, rate limit waits and usage land on the right span. Calls with a single chain are unchanged.
