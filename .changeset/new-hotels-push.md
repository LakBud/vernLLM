---
'vern-llm': patch
---

Fix `refundUsage` being called even when the corresponding `reserveUsage` call itself failed.

Previously, if `reserveUsage` threw (e.g. quota already exhausted), `refundUsage` would still fire for that caller, incorrectly refunding a reservation that was never actually made. `refundUsage` is now only invoked if `reserveUsage` succeeded, for both the triggering caller and coalesced callers in `cachedCall`/`cachedLLMCall`.
