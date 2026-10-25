---
'vern-llm-logger': patch
---

Records are correct for calls that run more than one chain with `next.again()`. Each chain's attempts are kept apart, so one chain no longer closes another's. A record for such a call sets `chains` and the kept `chain`, and takes `path`, `attemptMs`, `ttftMs` and `usage` from the kept chain only, so a cancelled chain never skews the latency series. `attempts` and `retries` still count every chain. Calls with one chain are recorded exactly as before.
