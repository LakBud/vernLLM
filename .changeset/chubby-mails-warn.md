---
'vern-llm': minor
---

`response_format: { type: 'json_object' }` is no longer emulated on `fromAnthropic`/`fromBedrock`
via an unenforced system-prompt instruction ("Respond with valid JSON only, no prose or markdown
fences."). Neither provider has a request field that mechanically guarantees JSON output for this
mode, so that instruction was a weaker guarantee than the type implied: the model could still
ignore it, wrap output in prose, or add a markdown fence. This is also the one place in the
codebase where an unsupported provider feature was silently degraded instead of failing loudly,
unlike every other cross-provider gap (e.g. `jsonSchema` + `tools` on an unsupported model already
throws instead of degrading).

Both `LLMClient` implementations now report this via a new `supportsJsonObjectMode?: boolean`
field (defaults to `true` when omitted; every OpenAI-compatible client and `fromGemini` are
unaffected, since both map `json_object` to a real API field). `fromAnthropic` and `fromBedrock`
set it to `false`, and `RequestBuilder`'s behavior branches on it:

- **An explicit `jsonMode: true`** (or `VernLLM.call({ jsonSchema })` isn't set and you asked for
  JSON directly) on a client with `supportsJsonObjectMode: false` now throws
  `LLMError('invalid_params')` before the request is ever sent, naming the client and pointing at
  `jsonSchema` as the real alternative.
- **The _default_, unset `jsonMode`, with no `schema` to validate against** — the common case of a
  plain `llm.call({ userContent })` — is silently downgraded to plain text instead of throwing.
  This is what keeps a bare `llm.call({ userContent })` working exactly as it did before on
  Anthropic/Bedrock, for callers who never actually wanted JSON in the first place and were just
  getting the library's default.
- **`schema` without `jsonSchema`** always requires real JSON output to validate against, so it
  always throws `LLMError('invalid_params')` on `supportsJsonObjectMode: false` clients, naming
  the real cause, whether `jsonMode` was set explicitly or left at its default. An implicit request
  for JSON (via `schema`) is deliberately _not_ silently downgraded the way a schema-less call is:
  doing so would skip validation entirely while reporting success.
- **`jsonSchema`** is completely unaffected either way: it was never routed through `json_object`,
  and maps to a real API-level constraint on both providers (native structured output or a forced
  single tool call).

If you were relying on `jsonMode: true` (explicitly or by default) to get JSON-shaped text on
Anthropic/Bedrock without a `jsonSchema`, switch to `jsonSchema`, which is a strictly stronger
guarantee anyway.

---

Added `fromBedrockClient(client, options?)`, an ergonomic alternative to `fromBedrock` for callers
who already depend on `@aws-sdk/client-bedrock-runtime`. It takes a real `BedrockRuntimeClient`
directly — no hand-written `.converse()`/`.converseStream()` wrapper required — and internally
calls `client.send(new ConverseCommand(params))` / `client.send(new ConverseStreamCommand(params))`.

`vern-llm` still has zero runtime dependencies: `@aws-sdk/client-bedrock-runtime` is not a
dependency of `vern-llm`, not even a peer dependency. `fromBedrockClient` pulls in
`ConverseCommand`/`ConverseStreamCommand` with a dynamic `import()` the first time it's actually
called, so nothing is added to `package.json`, bundlers only reach the AWS SDK for code paths that
call this function, and a missing install surfaces as a clear `LLMError` naming exactly what's
missing rather than a raw module-resolution error or a silent peer-dependency warning at install
time.

`fromBedrock(converseClient)` (the existing structural adapter) is unchanged and still the
zero-dependency option for callers who'd rather not add `@aws-sdk/client-bedrock-runtime` at all,
or who are on a different AWS SDK generation or a hand-rolled HTTP client.
