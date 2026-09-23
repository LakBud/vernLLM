---
'vern-llm': patch
---

Adapter payload fixes.

`fromBedrock` merges consecutive same-role turns, so a tool result followed by a user message no longer breaks Converse role alternation.
`fromOpenAICompatible` adds a JSON instruction when `json_object` is set and no message mentions "json", so a default `call()` no longer gets a 400 from OpenAI.
OpenAI reasoning models (the o-series and GPT 5 onward, such as `gpt-6-sol`) get `max_completion_tokens` instead of `max_tokens`, and no `temperature`.
A failed tool result on OpenAI-compatible adapters keeps its failure, sent as content prefixed with `Error: ` instead of being dropped.
