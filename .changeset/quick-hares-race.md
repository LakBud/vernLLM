---
'vern-llm-hedge': minor
---

First release. Sends a call that is slower than its target usually is to the next target too, keeps the first answer, and lets the core cancel the other.

The delay is learned from the logger's `attemptMs` percentiles per target, stream mode and prompt size bucket, and a token bucket keeps extra calls near 5% of eligible calls. `targets` and `when` decide where and whether to hedge. `maxHedges` sends up to four hedges per call, `adapt` adjusts each target's delay by how often its hedges win and emits `hedge.adapt`, and `cacheAware` waits longer or skips when the first target has the prompt cached. Each call reports one `hedge.decision`, and `hedgeDimension`, `promptSizeDimension` and `hedgeLogFields` read it from the logger.
