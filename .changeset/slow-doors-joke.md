---
'vern-llm': major
---

Added first-class tool calling support.

`call()` now accepts `tools`, an array of `ToolDefinition`s the model may request, and an optional `toolChoice` to control whether and which tool is used. When `tools` is set, `call()` returns a `CallWithToolsResult<T>` discriminated union (`{ type: 'content', content }` or `{ type: 'tool_calls', toolCalls, content? }`) instead of `T` directly. VernLLM never executes tools itself, applications run them and continue the conversation by appending an assistant `toolCalls` turn and a matching `tool` turn to `history`.

Every adapter (`fromAnthropic`, `fromBedrock`, `fromGemini`, and the OpenAI-compatible adapters) translates `tools`/`toolChoice`/`tool_calls` into that provider's native tool-calling mechanism. `cachedLLMCall()` supports tool-enabled calls the same way it supports plain ones.

This is a major release because of two breaking type changes:

- `ConversationTurn` is now a discriminated union instead of one flat `{ role, content }` shape, adding a `tool` case and making `content` optional on `assistant` turns. Constructing turns is unaffected; code that reads `turn.content` on an `assistant` turn assuming it's always a `string`, or that used an exhaustive `switch`/`assertNever` pattern over `role`, will need updating.
- `LLMClient.messages` widened to include tool turns and `tool_calls` on assistant messages. This only affects hand-written `LLMClient` implementations that bypass the built-in adapters and had an exhaustive role switch.

See the Tool Calling docs and Migration Notes for details.
