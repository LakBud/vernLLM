---
'vern-llm': patch
---

Cache adapter failures now go through logger.warn instead of being invisible. A get failure is treated as a miss and falls through to a real provider call. A set failure happens after the result is already computed and is still swallowed, just now logged. A delete failure used to propagate as a thrown error; it is now caught and logged instead.
