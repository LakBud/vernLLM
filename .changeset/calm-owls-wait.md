---
'vern-llm-router': minor
---

New `holdBack` option. A custom event that names a target in `data.target` holds it back like a 429 cooldown, so healthy targets go first for `holdMs` (default 10 seconds, at most 60).
