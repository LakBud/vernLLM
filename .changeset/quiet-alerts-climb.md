---
'vern-llm-usage': minor
---

`warnAt` also takes a list, such as `[0.7, 0.9]`, for escalating alerts. `usage.budget_warning` is emitted once per threshold, budget and window and carries a new `threshold` field. When one call jumps past several thresholds, only the highest is emitted. A single number still works.
