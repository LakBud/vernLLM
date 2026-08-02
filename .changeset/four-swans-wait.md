---
'vern-llm': patch
---

Internal refactor: extract `withReservedUsage` and `normalizeError` out of `VernLLM` into `internal/vernLLM.utils.ts` as standalone functions, with added unit test coverage. No public API or behavior changes.
