---
'vern-llm': patch
---

Fixed two cases where a provider limitation was misclassified as a validation error, which stopped `defaultFallbackOn` from trying the next target.

`fromAnthropic` and `fromBedrock` now throw `invalid_params` with code `unsupported_capability` when `tools` and `jsonSchema` are combined on a model not covered by `nativeStructuredOutputModels`, instead of `validation`. Fallback now falls through to the next target correctly.

`fromGemini` now assigns a unique wire id to each of two parallel calls to the same tool in one turn, instead of reusing the tool name for both and tripping the shared `duplicate_tool_call_id` check.
