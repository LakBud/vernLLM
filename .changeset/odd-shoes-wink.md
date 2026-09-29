---
'vern-llm': minor
---

Target names must be unique.

`VernLLM` now throws at construction when two targets, the primary or a fallback, share a name. Defaults count, so a fallback named `primary` collides with an unnamed primary. Usage and events identify a target by name, so a shared name merged their data.
