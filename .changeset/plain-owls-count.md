---
'vern-llm-usage': minor
---

Reports the spend of chains whose result was not returned, for calls that run more than one chain.

`unkeptUsd` is the part of `estimatedCostUsd` spent by chains other than the one whose answer was returned. It is on the call's log fields when above zero, and in `totals()` as a sum. Only spend reported before the call finishes is counted.
