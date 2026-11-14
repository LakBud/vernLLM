<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/logo.png" alt="vern-llm logo" width="96" />
</p>

<h1 align="center">vern-llm</h1>

<p align="center">
  <a href="https://github.com/LakBud/vernLLM">GitHub</a> ·
  <a href="https://vernllm.dev">Documentation</a> ·
  <a href="https://vernllm.dev/docs/why">Why VernLLM</a> ·
  <a href="https://www.npmjs.com/package/vern-llm">npm</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/v/vern-llm.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/dm/vern-llm.svg" alt="npm downloads" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/ci.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://codecov.io/gh/LakBud/vernLLM"><img src="https://codecov.io/gh/LakBud/vernLLM/graph/badge.svg?token=NKKW54MODY" alt="codecov" /></a>
  <a href="https://github.com/LakBud/vernLLM/blob/main/LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/node/v/vern-llm.svg" alt="node version" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

<p align="center">The LLM call framework for TypeScript: resilience, observability, and control for every call, running inside your own process instead of behind a gateway.</p>

LLM providers fail in ways a status code doesn't show: a 200 with an empty body, JSON cut off at `max_tokens`, a stream that dies before its first chunk, an outage that your own retries make worse. vern-llm sees the whole call, not only the HTTP request, so it can handle all of them:

- **Resilience.** Calls keep working when providers fail, and a failing provider can't take your app down with it.
- **Observability.** Every retry, fallback, wait, and breaker change is reported, tied to the call and the tenant that caused it.
- **Control.** Your code decides which providers a call may use, in what order, and when to give up.

It works with OpenAI compatible providers, Anthropic, Gemini, and Bedrock through one interface, and has zero runtime dependencies. This README is a quick reference: the manual is at [vernllm.dev](https://vernllm.dev).

## Installation

You will need Node.js 22.22 or newer.

```bash
npm i vern-llm
```

Provider SDKs and `zod` are optional. Install the ones you use, for example `npm i openai`.

## Quick start

```ts
import OpenAI from 'openai';
import { VernLLM } from 'vern-llm';
import { fromOpenAI } from 'vern-llm/adapters';

const llm = new VernLLM({
  client: fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 })),
  model: 'gpt-6-sol',
});

const text = await llm.call({ userContent: 'Say hello.', jsonMode: false });
```

JSON mode is on by default, so `call` returns parsed JSON unless you pass `jsonMode: false`. Pass `maxRetries: 0` to provider SDKs so vern-llm is the only retry authority.

## What it handles

Each row is a failure that looks fine from the outside, and what vern-llm does about it:

| What goes wrong                                           | What vern-llm does                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A 200 with an empty body, or JSON cut off at `max_tokens` | Treats it as a failure, so it retries, falls back, and counts against that target's breaker                     |
| A stream that errors after the 200 but before any content | Retries and falls back, even after a keep-alive ping opened the stream                                          |
| A primary that keeps failing                              | Opens its breaker, so calls skip it and go straight to the fallback instead of paying for failed attempts first |
| Retries tripling your traffic in the middle of an outage  | A retry budget caps retries at a share of each target's traffic                                                 |
| A bad request, a schema mismatch, or a rejected budget    | Fails fast without tripping the breaker, since it says nothing about the provider's health                      |
| A burst that would hit your account's rate limit          | Queues within requests, tokens, and concurrency limits per target, and shrinks them after a 429                 |
| A cache that errors                                       | Treats a failing cache as a miss, and serves concurrent misses for one key with a single provider call          |
| Every provider failing at once                            | Fails fast with a `FallbackExhaustedError` that carries every attempt                                           |

## Usage

### Surviving an outage

```ts
import Anthropic from '@anthropic-ai/sdk';
import { fromAnthropic, fromOpenAI } from 'vern-llm/adapters';

const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-6-sol',
  fallback: {
    name: 'anthropic',
    client: fromAnthropic(new Anthropic({ maxRetries: 0 })),
    model: 'claude-opus-5-5',
    circuitBreaker: true,
  },
  retryBudget: { windowMs: 60_000, minCalls: 20, retryRatio: 0.2 },
  rateLimit: { requestsPerMinute: 500, tokensPerMinute: 100_000, maxConcurrent: 20 },
  maxRetries: 3,
  timeoutMs: 10_000,
  onEvent: (event) => {
    if (event.kind === 'fallback') console.warn(`fallback ${event.from} -> ${event.to}`);
  },
});
```

Every target gets its own retries, breaker, limiter, and budget, so a struggling primary can't use up what a healthy fallback needs.

### Structured output

Pass any validator as `schema`. A mismatch throws a typed `validation` error, and JSON cut off at `max_tokens` is retried instead of returned.

```ts
import { z } from 'zod';

const candidate = await llm.call({
  systemPrompt: 'Extract the candidate name and skills as JSON.',
  userContent: resumeText,
  schema: z.object({ name: z.string(), skills: z.array(z.string()) }),
});
```

### Streaming

```ts
const { chunks, finalResult } = await llm.call({
  userContent: 'Write a short poem about the ocean.',
  jsonMode: false,
  stream: true,
});

for await (const chunk of chunks) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
}

const result = await finalResult;
```

### Tool calling

vern-llm returns typed tool calls. You run the tools and continue the conversation.

```ts
const getWeather = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const result = await llm.call({
  userContent: 'What is the weather in New York?',
  tools: [getWeather],
});

if (result.type === 'tool_calls') {
  for (const call of result.toolCalls) console.log(call.name, call.arguments);
}
```

### Handling errors

Every error is an `LLMError` with a type and a code, so your code can tell a schema failure from an open circuit:

```ts
import { isLLMError } from 'vern-llm';

try {
  await llm.call({ systemPrompt, userContent, schema });
} catch (err) {
  if (isLLMError(err) && err.type === 'circuit_open') {
    // provider is down, back off and do not retry immediately
  }
  throw err;
}
```

## Everything in the box

### Resilience

- **Retries**: full jitter backoff that honors `Retry-After` up to your cap. Validation and caller errors fail fast
- **Retry budget**: caps retries at a share of each target's traffic, so an outage can't turn into a retry storm
- **Circuit breaker per target**: consecutive, rolling, or custom tripping, with half open trials and a success ratio for recovery. Caller errors never open it
- **Soft failures**: an empty body, truncated JSON, a stream that fails before its first chunk, or anything `detectSoftFailure` flags counts as a failure, even behind a 200
- **Ordered fallback**: when every target is open, the call fails fast with `FallbackExhaustedError`
- **Client side rate limiting**: requests, tokens, and concurrency per target, with a wait queue that adapts after or ahead of a 429
- **Timeouts**: per attempt, whole call via `deadlineMs`, stream idle, and reader stall
- **Caching**: `cachedCall` shares one provider call across concurrent misses, treats a failing cache as a miss, and never caches a failed call

### Observability

- **One event stream**: `onEvent` reports retries, fallbacks, breaker transitions, rate limit waits, usage, and middleware events from `ctx.emit`
- **Usage on success and failure**: `onUsage` and `onUsageFailure`, with prompt cache reads and writes split out
- **Typed errors**: 12 error types and 38 codes, and each `LLMError` carries every attempt with its request snapshot, auth headers stripped
- **Live health state**: `getCircuitStates()`, `getFailureBreakdown()`, `getRetryBudgetState()`, and `readRateLimitState()`

### Control

- **Per call targets**: `targets: ['bedrock', 'primary']` picks the providers and order for one call
- **Middleware**: `transform` patches each attempt, `wrap` runs once around the whole call, and `dispatch` sees the final request
- **Policy that only narrows**: a `wrap` can drop or reorder targets through `next({ targets })`, and an inner one can never add back what an outer one removed
- **Fallback decisions**: `fallbackOn` sees the error, the failed target, and the next one
- **Call scoped data**: `context` reaches every hook, event, and usage report
- **Manual breakers**: `openCircuit()` and `closeCircuit()` per target
- **No surprises**: vern-llm never reorders targets on its own, and bad config throws at construction

## Why not a gateway

A gateway sees an HTTP request and response. vern-llm sees the call: the schema the answer must pass, the tenant it belongs to, and which providers it may use. That changes three things:

1. **It judges the answer, not the status code.** A 200 with an unusable body is a failure.
2. **It tells your fault from the provider's.** A bad request never opens the circuit for everyone.
3. **It adds nothing that can fail.** No extra network hop, no server to run, and prompts never pass through a third party.

It is not a gateway, dashboard, key manager, pricing table, or agent framework, and it never executes tools for you. It works alongside one: point an OpenAI compatible adapter at LiteLLM, Portkey, or `fromVercelAIGateway`, and pick one retry owner. See [Why VernLLM](https://vernllm.dev/docs/why) for the full comparison with the AI SDK, LiteLLM, and Portkey.

## Built to be depended on

- **Zero runtime dependencies**, so there is nothing transitive to audit.
- **A size cap in CI:** the bundle must stay under 120 KB, and the adapters entry under 12 KB.
- **Over 2,400 tests**, with coverage gates and CodeQL scanning.
- **An overhead benchmark in CI**, which fails when a call gets slower than its baseline.
- **npm provenance** on every release, and a changeset for every behavior change that spells out what changes at runtime.

## Adapters

Adapters live on the `vern-llm/adapters` entry, so the main entry stays provider free.

| Adapter                                 | Providers                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `fromOpenAI` and `fromOpenAICompatible` | OpenAI, plus 36 named providers such as Groq, Mistral, DeepSeek, Cerebras, Together AI, Fireworks AI, Ollama, OpenRouter, xAI, and vLLM |
| `fromAnthropic`                         | Anthropic                                                                                                                               |
| `fromGemini`                            | Gemini                                                                                                                                  |
| `fromFetch`                             | Any provider reachable over HTTP, with your own URL, headers, and request and response mapping                                          |
| `fromBedrock`                           | AWS Bedrock, from [`vern-llm-bedrock`](https://www.npmjs.com/package/vern-llm-bedrock)                                                  |

## Related packages

Everything beyond core is optional and depends only on `vern-llm`.

| Package                                                              | What it adds                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`vern-llm-logger`](https://www.npmjs.com/package/vern-llm-logger)   | One structured record per call, rolling latency percentiles, slow call alerts   |
| [`vern-llm-usage`](https://www.npmjs.com/package/vern-llm-usage)     | Estimated cost and wasted spend per call, budgets that reject early             |
| [`vern-llm-router`](https://www.npmjs.com/package/vern-llm-router)   | Target order from rules, health, latency, or cost, with dry run and shadow mode |
| [`vern-llm-policy`](https://www.npmjs.com/package/vern-llm-policy)   | Removes forbidden targets, fails closed, and audits every decision              |
| [`vern-llm-guard`](https://www.npmjs.com/package/vern-llm-guard)     | Labels, redacts, or blocks what goes into a call and what comes out             |
| [`vern-llm-hedge`](https://www.npmjs.com/package/vern-llm-hedge)     | Sends a slow call to the next target too and keeps the first answer             |
| [`vern-llm-redis`](https://www.npmjs.com/package/vern-llm-redis)     | Shares breaker, rate limit, retry budget, and cache state across processes      |
| [`vern-llm-otel`](https://www.npmjs.com/package/vern-llm-otel)       | OpenTelemetry traces and metrics that follow the GenAI semantic conventions     |
| [`vern-llm-bedrock`](https://www.npmjs.com/package/vern-llm-bedrock) | AWS Bedrock Converse models through the AWS SDK's own client                    |

## License

[MIT](https://github.com/LakBud/vernLLM/blob/main/LICENSE.md) © LakBud
