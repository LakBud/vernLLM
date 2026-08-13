---
'vern-llm': patch
---

Added `fromOpenAI`, a named adapter alias for OpenAI itself, alongside the existing
`fromOpenAICompatible` aliases for Groq, Mistral, and the rest.

Passing a raw `new OpenAI(...)` instance directly as `client` structurally satisfies `LLMClient`
for basic non-streaming, text-only calls, but silently misses two things that only live in the
adapter layer: `ContentBlock[]` multimodal translation to OpenAI's `image_url` format, and
`createStream` wiring for `stream: true` (the raw SDK has no `createStream` method). Newer `openai`
SDK majors (v7+) also widened `ChatCompletionContentPart` in ways that can make an unwrapped client
fail to typecheck against `LLMClient` altogether, independent of any VernLLM version, since `openai`
is not a peer dependency here.

`fromOpenAI(client)` is a plain alias for `fromOpenAICompatible(client)`, no behavior change beyond
the name. Existing code passing a raw client is unaffected; `fromOpenAI` is the recommended path
going forward. See [Migration Notes](https://vernllm.vercel.app/docs/migration-notes) for details.
