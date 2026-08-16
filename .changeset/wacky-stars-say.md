---
'vern-llm': patch
---

Cache adapter get, set, and delete failures now call logger.warn instead of being swallowed silently. The failure itself is still swallowed, so a broken cache adapter still falls through to a real provider call, it's just no longer invisible.
