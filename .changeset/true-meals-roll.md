---
'vern-llm': minor
---

Added tool calling support to the generic `fromFetch` adapter.

`mapResponse` can now return an optional `toolCalls` array alongside `content`: `{ id, name, arguments }` per call, with `arguments` already JSON-encoded as a string, the same wire format every other adapter produces. `fromFetch` translates these into `WireToolCall`s so `call()` surfaces them through `CallWithToolsResult` exactly like the built-in provider adapters. `mapRequest` already received the full request (including `tools`/`toolChoice`) before this change, so only the response side needed a new seam.

`content` is now optional on `mapResponse`'s return type too, since a pure tool-call turn may have no text. An empty `toolCalls` array is treated identically to an omitted one, no special-casing needed either way.

This is purely additive. Existing `fromFetch` configs that never set `tools` and return only `{ content, usage? }` from `mapResponse` are unaffected.

See the Custom Providers docs for a full example.
