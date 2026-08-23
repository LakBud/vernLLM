---
'vern-llm': patch
---

Fixed two bugs in the Gemini adapter's tool call handling.

Parallel calls to the same tool in one turn no longer throw a spurious `duplicate_tool_call_id` validation error. The adapter previously built every wire tool call id from the function name alone, so two calls to `get_weather` in the same turn always collided. Gemini 3 and later now populate a native, unique `id` on every `functionCall`, and the adapter uses it when present. On models before Gemini 3 that omit it, an id is synthesized from the function name plus how many times that name has already appeared in the response, so repeated calls to the same tool still get distinct ids.

`functionResponse.name` sent back to Gemini is now resolved from the assistant turn's own prior tool call, instead of being assumed equal to the wire tool call id. The old assumption only held because ids were always synthesized from the name; it silently sent the wrong function name whenever a native id didn't match the name string.

No change to `WireToolCall`, `ToolCall`, or any other adapter. Every fix stays inside `adapters/gemini.ts`.
