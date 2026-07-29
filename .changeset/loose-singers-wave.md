---
'vern-llm': patch
---

Throw `LLMError('validation')` when `schema` is combined with `jsonMode: false` (without `jsonSchema`), instead of silently skipping validation and returning an unvalidated string cast to the schema's type.
