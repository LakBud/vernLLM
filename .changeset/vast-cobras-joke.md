---
'vern-llm': patch
---

Fix cache key normalization, tiered cache key resolution, and structured output adapter metadata forwarding.

- **`NormalizedCacheAdapter`**: punctuation is now replaced with a space instead of being removed outright. Previously `"2+2"` and `"2 + 2"` normalized differently (`"22"` vs `"2 2"`) because removing punctuation collapsed adjacent characters. Both now normalize consistently to `"2 2"`.

- **`TieredCacheAdapter`**: now implements `resolveKey`, forwarding to L1's implementation if present, otherwise L2's, otherwise returning the original key unchanged.

- **`fromAnthropic`**: `jsonSchema` now forwards schema metadata into Anthropic tool use. The adapter passes `name`, `description`, `input_schema`, and `strict` into the generated tool definition and continues using forced tool calls for structured output.

- **`fromBedrock`**: `jsonSchema` now forwards schema metadata into Bedrock Converse tool use. The adapter passes `name`, `description`, `inputSchema`, and `strict` into the generated tool spec and forces tool selection through `toolChoice`. Strict enforcement depends on the selected Bedrock model's tool support.

- **`fromGemini`**: `jsonSchema` now forwards schema descriptions into Gemini's `generationConfig.responseSchema`. Structured output uses `responseMimeType: 'application/json'` with `responseSchema`; Gemini does not use a separate `strict` flag.

- Removed references to the deprecated `@google/generative-ai` SDK from Gemini adapter docs and comments. The adapter uses structural typing and is not SDK-specific.

Docs updated in:
`core/caching.mdx`, `guides/caching-methods/normalized.mdx`, `guides/caching-methods/tiered.mdx`, `core/structured-output.mdx`, and `adapters/gemini.mdx`.

Tests added covering punctuation normalization, `TieredCacheAdapter.resolveKey` forwarding, and structured output adapter behavior.
