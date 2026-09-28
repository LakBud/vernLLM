---
'vern-llm': major
---

Adapters import from `vern-llm/adapters`, `fromGemini` takes the top level client, and `fromBedrock` moves to its own package, `vern-llm-bedrock`.

Adapters: every `from*` factory, their option types, `ModelCapabilityOverride`, `parseSseStream` and `SSE_PING` moved off the root entry to the new `vern-llm/adapters` subpath. `LLMClient`, the wire types and everything else stay on `vern-llm`. Both entries share one `LLMError` class, so `instanceof` checks keep working. The rules adapter packages share with the built-in adapters are exported there too: `supportsNativeStructuredOutput`, `rejectsForcedToolChoice`, `assertForcedToolChoiceSupported`, `throwMissingForcedJsonSchemaTool`, `assertForcedJsonSchemaToolInputIsObject`, `assertSupportedImageMimeType`, the Claude reasoning budget helpers, and `planClaudeStructuredOutput` and `resolveClaudeThinking`, which apply Claude's structured output and thinking rules to a request.

Gemini: pass `ai`, the `GoogleGenAI` instance. `fromGemini(ai.models)` throws a plain `Error` at construction that says to pass `ai`, and `GeminiClient` now describes the top level client, with the model methods under `models`.

Bedrock: `fromBedrock` now ships in `vern-llm-bedrock`. Install it with `@aws-sdk/client-bedrock-runtime`, import `fromBedrock` from it, and pass a `BedrockRuntimeClient`. The hand-written `{ converse, converseStream }` client form and `BedrockConverseClient` are gone. `vern-llm` no longer loads the AWS SDK at all.
