# vern-llm

Retry + timeout + cache wrapper for OpenAI-compatible chat completion calls (OpenAI, Groq, Anthropic via adapter).

## Install

```bash
pnpm add vern-llm openai
```

## Basic usage

```ts
import OpenAI from 'openai';
import { VernLLM } from 'vern-llm';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
});

const parsed = await llm.call({
  systemPrompt: 'Return JSON: { "skills": string[] }',
  userContent: 'Extract skills from: ...',
});

// jsonMode: false returns the raw string, no parsing
const text = await llm.call({
  systemPrompt: 'Summarize this.',
  userContent: '...',
  jsonMode: false,
});
```

`VernLLM` is also exported as `RetryLLM` — same class, same behavior, pick whichever name reads better in your codebase:

```ts
import { RetryLLM } from 'vern-llm';

const llm = new RetryLLM({ client: openai, model: 'gpt-4o' });
```

## Structured output with Zod

Pass a `schema` and get a typed, validated result. Works with any validator exposing `safeParse` (Zod v3/v4).

```ts
import { z } from 'zod';

const CandidateSchema = z.object({
  name: z.string(),
  skills: z.array(z.string()),
});

// result is typed as z.infer<typeof CandidateSchema>
const result = await llm.call({
  systemPrompt: 'Extract the candidate name and skills as JSON.',
  userContent: resumeText,
  schema: CandidateSchema,
});
```

On a schema mismatch, `call` throws `LLMError('validation')` with `.issues` set to the validator's error object, without burning a retry (validation failures are deterministic).

## Provider-native JSON Schema mode

`schema` above only validates client-side, after the model has already responded. `jsonSchema` sends the schema to the provider (OpenAI/Groq `response_format: { type: 'json_schema' }`), constraining generation itself — the model can't produce a shape that violates it. Combine both for provider-level constraint plus typed client-side inference:

```ts
const result = await llm.call({
  systemPrompt: 'Extract the candidate name and skills.',
  userContent: resumeText,
  jsonSchema: {
    name: 'Candidate',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'skills'],
    },
  },
  schema: CandidateSchema, // optional client-side type/validation on top
});
```

`jsonSchema` implies JSON mode. The Anthropic adapter has no native structured-output equivalent, so it embeds the schema in the system prompt as an instruction instead of provider-enforcing it.

## Per-call model override and reasoning effort

```ts
const llm = new VernLLM({ client: openai, model: 'gpt-4o-mini' }); // default model

await llm.call({
  systemPrompt: '...',
  userContent: '...',
  model: 'o3',                 // overrides the instance default for this call only
  reasoningEffort: 'high',     // passed through as `reasoning_effort`; ignored by models that don't support it
});
```

`reasoningEffort` is dropped by the Anthropic adapter — Claude's extended thinking uses a token budget, not an effort tier, so there's no faithful 1:1 mapping.

## Caching + usage metering

```ts
import { InMemoryCacheAdapter } from 'vern-llm';

const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  cache: new InMemoryCacheAdapter(), // swap for your own Redis/Upstash adapter
});

const result = await llm.cachedCall({
  cacheKey: `cv:${cvId}`,
  ttl: 3600,
  fn: () => llm.call({ systemPrompt, userContent }),
  reserveUsage: () => quota.reserve(userId),
  refundUsage: () => quota.refund(userId),
});
```

If `refundUsage` itself throws, that failure is logged and swallowed — the original error from `fn` (or the cache write) is what propagates, so a broken refund path never masks the real failure.

### `cachedLLMCall` — cached + retried in one call

`cachedCall` is a thin cache wrapper; it doesn't apply retry/timeout/circuit-breaker behavior on its own — that's up to whatever `fn` does. If `fn` is always going to be `() => llm.call(...)`, `cachedLLMCall` wires that up for you:

```ts
const result = await llm.cachedLLMCall({
  cacheKey: `cv:${cvId}`,
  ttl: 3600,
  call: { systemPrompt, userContent }, // same shape as call()'s params
  reserveUsage: () => quota.reserve(userId),
  refundUsage: () => quota.refund(userId),
});
```

### Custom cache adapter

```ts
import type { CacheAdapter } from 'vern-llm';

class UpstashCacheAdapter implements CacheAdapter {
  async get(key: string) { /* ... */ }
  async set(key: string, value: unknown, ttl: number) { /* ... */ }
}
```

## Token usage tracking

```ts
const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  onUsage: (usage) => {
    // { promptTokens, completionTokens, totalTokens, requestId, model }
    billing.record(usage);
  },
});
```

## Circuit breaker

Stops hammering a provider that's down instead of retrying every call.

```ts
const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  circuitBreaker: { threshold: 5, cooldownMs: 30_000 }, // or `true` for defaults
});

llm.getCircuitState(); // 'closed' | 'open' | 'half-open' | undefined
```

Once `threshold` consecutive failures occur, further calls fail immediately with `LLMError('circuit_open')` until `cooldownMs` elapses, at which point one trial call is allowed through (half-open). A successful trial closes the circuit; a failed one reopens it.

## Pluggable logger

```ts
import type { Logger } from 'vern-llm';

const pinoLogger: Logger = {
  debug: (msg) => logger.debug(msg),
  warn: (msg) => logger.warn(msg),
  error: (msg, meta) => logger.error(meta, msg),
};

const llm = new VernLLM({ client: openai, model: 'gpt-4o', logger: pinoLogger });
```

Defaults to a console logger; `debug` logging is gated by the `debug` option (`NODE_ENV !== 'production'` by default), `warn`/`error` always fire.

## Multi-provider adapters

`VernLLM` expects a client shaped like OpenAI's `chat.completions.create`. Some providers already match that shape and need no adapter; others need one that translates their native API into it.

### Already OpenAI-wire-compatible — zero-transform passthrough

Groq, Mistral, DeepSeek, Cerebras, Together AI, Fireworks AI, and Ollama (via its `/v1/chat/completions` endpoint) all speak the same wire format as OpenAI. These are thin named wrappers around the same passthrough — pick whichever name matches your provider for readability:

```ts
import { VernLLM, fromGroq, fromMistral, fromTogether } from 'vern-llm';

const llm = new VernLLM({
  client: fromGroq(new Groq({ apiKey: process.env.GROQ_API_KEY })),
  model: 'llama-3.3-70b-versatile',
});
```

`fromOpenAICompatible()` is the underlying function if your provider isn't in the named list — same thing, generic name.

### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk';
import { VernLLM, fromAnthropic } from 'vern-llm';

const llm = new VernLLM({
  client: fromAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })),
  model: 'claude-sonnet-4-6',
});
```

No native `response_format` or `reasoning_effort` equivalent — JSON mode/schema are emulated via a system-prompt instruction (schema text embedded, not provider-enforced); `reasoning_effort` is dropped.

### Gemini

```ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import { VernLLM, fromGemini } from 'vern-llm';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const llm = new VernLLM({ client: fromGemini(model), model: 'gemini-2.5-flash' });
```

Unlike Anthropic, `jsonSchema` maps to Gemini's native `responseSchema` + `responseMimeType: 'application/json'`, so it's actually provider-enforced here. `reasoning_effort` is dropped (Gemini's thinking models use a token budget instead).

### AWS Bedrock

Bedrock's SDK v3 exposes `.send(command)`, not a direct method, so wrap it:

```ts
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { VernLLM, fromBedrock } from 'vern-llm';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });

const llm = new VernLLM({
  client: fromBedrock({
    converse: (params, options) =>
      client.send(new ConverseCommand(params), { abortSignal: options.signal }),
  }),
  model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
});
```

Uses Bedrock's Converse API, which is unified across model families (Anthropic, Titan, Llama, Mistral, etc. all speak the same request/response shape), so this one adapter works regardless of which `model` you point it at. JSON mode is emulated via system prompt, same as Anthropic; `reasoning_effort` is dropped.

### Anything else — `fromFetch`

For a provider with no SDK, or where pulling one in isn't worth it, `fromFetch` is a raw HTTP escape hatch — supply the URL, headers, and two small mapping functions, and retries/timeouts/circuit-breaker/JSON handling all still apply:

```ts
import { VernLLM, fromFetch } from 'vern-llm';

const llm = new VernLLM({
  client: fromFetch({
    url: 'https://api.example.com/v1/generate',
    headers: () => ({ Authorization: `Bearer ${process.env.EXAMPLE_API_KEY}` }),
    mapRequest: (params) => ({
      model: params.model,
      prompt: params.messages.map((m) => m.content).join('\n\n'),
      max_tokens: params.max_tokens,
    }),
    mapResponse: (json) => ({
      content: json.output,
      usage: { promptTokens: json.usage?.input, completionTokens: json.usage?.output },
    }),
  }),
  model: 'example-model-v1',
});
```

Non-2xx responses throw with `.status` set, so `nonRetryableStatus` still fails fast on 401/403 as usual.

## Notes

- Requires Node 20+ (`AbortSignal.any`).
- Non-retryable status codes (default `400, 401, 403`) fail fast instead of burning a retry, and are reported as `LLMError('api', status)` rather than a generic unknown error.
- An already-aborted `signal` rejects immediately with `LLMError('aborted')` before any request is dispatched.
- `jsonMode: false` skips JSON parsing entirely and returns the raw string.
- `zod` and provider SDKs (`openai`, `groq-sdk`, `@anthropic-ai/sdk`) are not bundled — bring your own; this package only relies on their shapes structurally.

## Development

```bash
pnpm install
pnpm run build            # tsdown → dist (ESM + CJS + types)
pnpm run typecheck        # tsc --noEmit on src, since tsdown doesn't fully type-check
pnpm run typecheck:test   # tsc --noEmit on src + test (separate tsconfig, no rootDir conflict)
pnpm run test             # vitest run
pnpm run test:watch       # vitest, watch mode
pnpm run test:coverage    # vitest run --coverage (v8 provider)
pnpm run changeset        # record a change for the next release
```

Tests live in `tests/`, mirroring `src/`: `VernLLM.call.test.ts` and `VernLLM.schema.test.ts` cover retry/backoff/timeout/abort/schema/model-override/usage behavior, `circuitBreaker.test.ts` covers the breaker as a unit and its integration with `call()`, `cachedCall.test.ts` covers caching and usage reservation/refund, `logger.test.ts` covers the injectable logger, and `test/adapters/*.test.ts` cover each provider adapter's request/response translation against a fake client, no real API calls are made anywhere in the suite.