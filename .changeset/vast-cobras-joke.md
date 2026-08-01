---
'vern-llm': patch
---

Fix `NormalizedCacheAdapter` treating punctuation-adjacent keys as different entries, and add `resolveKey` forwarding to `TieredCacheAdapter`.

- **`NormalizedCacheAdapter`**: punctuation is now replaced with a space instead of being deleted outright. Previously `"2+2"` and `"2 + 2"` normalized to different strings (`"22"` vs `"2 2"`) since stripping `+` without surrounding whitespace collapsed adjacent characters together. Both now normalize to `"2 2"`.
- **`TieredCacheAdapter`**: now implements `resolveKey`, forwarding to L1's implementation if present, otherwise L2's, otherwise returning the key unchanged. This means a `resolveKey`-implementing adapter (e.g. `NormalizedCacheAdapter`) can now be passed directly as a tier and get non-exact matching without needing to be wrapped around the tiered pair as a workaround.

Also removes references to the deprecated `@google/generative-ai` SDK from `fromGemini`'s docs and internal comments, since it's no longer published and the adapter's structural typing was never actually SDK-specific.

Corrects a stale doc claim that `jsonSchema.description` is dropped for Anthropic — the adapter already forwards it to the tool spec it builds (`{ name, description, input_schema }`), same as Bedrock.

Docs updated in `core/caching.mdx`, `guides/caching-methods/normalized.mdx`, `guides/caching-methods/tiered.mdx`, `core/structured-output.mdx`, and `adapters/gemini.mdx` to match.

Tests added in `cachedCall.unit.test.ts` covering the punctuation normalization fix and `TieredCacheAdapter`'s `resolveKey` forwarding (L1 preferred, L2 fallback, no-op when neither tier implements it).
