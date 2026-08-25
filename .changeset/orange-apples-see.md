---
'vern-llm': patch
---

Retry After parsing now checks millisecond headers (`Retry-After-Ms`, `X-Retry-After-Ms`) some providers send in addition to the standard `Retry-After` header, accepts a decimal seconds value, and treats a negative delta or a past HTTP date as absent instead of clamping it to an immediate 0ms retry.
