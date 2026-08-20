---
'vern-llm': minor
---

`response_format: { type: 'json_object' }` is no longer emulated on `fromAnthropic`/`fromBedrock`
via an unenforced system-prompt instruction ("Respond with valid JSON only, no prose or markdown
fences."). Neither provider has a request field that mechanically guarantees JSON output for this
mode. That instruction was a weaker guarantee than the type implied: the model could still ignore
it, wrap output in prose, or add a markdown fence. This was also the one place in the codebase
where an unsupported provider feature was silently degraded instead of failing loudly, unlike
every other cross-provider gap (e.g. `jsonSchema` + `tools` on an unsupported model already throws
instead of degrading).

Both `LLMClient` implementations now report this via a new `supportsJsonObjectMode?: boolean`
field (defaults to `true` when omitted; every OpenAI-compatible client and `fromGemini` are
unaffected, since both map `json_object` to a real API field). `fromAnthropic` and `fromBedrock`
set it to `false`, and `RequestBuilder`'s behavior branches on it:

- **An explicit `jsonMode: true`** (or `VernLLM.call({ jsonSchema })` isn't set and you asked for
  JSON directly) on a client with `supportsJsonObjectMode: false` now throws
  `LLMError('invalid_params')` before the request is ever sent, naming the client and pointing at
  `jsonSchema` as the real alternative.
- **The _default_, unset `jsonMode`, with no `schema` to validate against**, the common case of a
  plain `llm.call({ userContent })`, is silently downgraded to plain text instead of throwing.
  This keeps a bare `llm.call({ userContent })` working exactly as before on Anthropic/Bedrock, for
  callers who never actually wanted JSON and were just getting the library's default.
- **`schema` without `jsonSchema`** always requires real JSON output to validate against, so it
  always throws `LLMError('invalid_params')` on `supportsJsonObjectMode: false` clients, naming
  the real cause, whether `jsonMode` was set explicitly or left at its default. An implicit request
  for JSON (via `schema`) is deliberately not silently downgraded the way a schema-less call is:
  doing so would skip validation entirely while reporting success.
- **`jsonSchema`** is unaffected either way: it was never routed through `json_object`, and maps
  to a real API-level constraint on both providers (native structured output or a forced single
  tool call).

If you were relying on `jsonMode: true` (explicitly or by default) to get JSON-shaped text on
Anthropic/Bedrock without a `jsonSchema`, switch to `jsonSchema`. It's a strictly stronger
guarantee anyway.
