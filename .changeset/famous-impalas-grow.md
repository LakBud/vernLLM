---
'vern-llm': minor
---

Add `estimateFraction` to `RateLimitOptions`. Scales the pre-flight token estimate down before it's reserved against `tokensPerMinute`, since most calls don't use their full `max_tokens` budget. Default `1`, matching prior behavior. Never changes the `max_tokens` sent to the provider; reconciliation against real usage on `release` is unaffected.
