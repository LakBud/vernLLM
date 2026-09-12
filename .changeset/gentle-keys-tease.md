---
'vern-llm': minor
---

`fromBedrock`'s legacy `jsonSchema` path now throws `LLMError('validation')` when Bedrock doesn't return a compliant forced tool call, in both `create()` and `createStream()`.

Two cases are covered. The tool is missing entirely (previously resolved with empty content). The tool's `input` isn't a JSON object (previously stringified whatever was returned, e.g. `null` or an array, as if it were valid structured output).

This matches `fromAnthropic`'s existing behavior for the same scenario. Anyone relying on the old silent empty content or malformed passthrough should catch `LLMError` with `type: 'validation'` instead.
