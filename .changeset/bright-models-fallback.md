---
'vern-llm': patch
---

Anthropic and Bedrock now classify `tools` combined with `jsonSchema` on models outside
`nativeStructuredOutputModels` as `LLMError('invalid_params')` with
`code: 'unsupported_capability'` and `issues: { capability: 'tools_with_json_schema' }`. The
existing `defaultFallbackOn` policy can therefore continue to the next target instead of stopping
on the adapter's local capability restriction.
