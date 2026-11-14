<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/banner.png" alt="VernLLM banner" />
</p>

<h1 align="center">VernLLM</h1>

<p align="center">
  <a href="https://vernllm.dev">Documentation</a> ·
  <a href="https://vernllm.dev/docs/why">Why VernLLM</a> ·
  <a href="https://npmjs.com/package/vern-llm">npm</a> ·
  <a href="https://x.com/VernLLM">X</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/v/vern-llm.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/dm/vern-llm.svg" alt="npm downloads" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/ci.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://codecov.io/gh/LakBud/vernLLM"><img src="https://codecov.io/gh/LakBud/vernLLM/graph/badge.svg?token=NKKW54MODY" alt="codecov" /></a>
  <a href="https://www.bestpractices.dev/projects/14212"><img src="https://www.bestpractices.dev/projects/14212/badge" alt="OpenSSF Best Practices" /></a>
  <a href="./LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
</p>

<p align="center"><a href="https://vernllm.dev">VernLLM</a> is the LLM call framework for TypeScript: resilience, observability, and control for every call, running inside your own process instead of behind a gateway.</p>

LLM providers fail in ways a status code doesn't show: a 200 with an empty body, JSON cut off at `max_tokens`, a stream that dies before its first chunk, an outage that your own retries make worse. VernLLM sees the whole call, not only the HTTP request, so it can handle all of them:

- **Resilience.** Calls keep working when providers fail, and a failing provider can't take your app down with it.
- **Observability.** Every retry, fallback, wait, and breaker change is reported, tied to the call and the tenant that caused it.
- **Control.** Your code decides which providers a call may use, in what order, and when to give up.

It works with OpenAI compatible providers, Anthropic, Gemini, and Bedrock through one interface, and has zero runtime dependencies. See [Why VernLLM](https://vernllm.dev/docs/why) for the comparison with the AI SDK, LiteLLM, and Portkey.

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

JSON mode is on by default, so `call` returns parsed JSON unless you pass `jsonMode: false`. Pass `maxRetries: 0` to provider SDKs so VernLLM is the only one that retries.

## What it handles

Each row is a failure that looks fine from the outside, and what VernLLM does about it:

| What goes wrong                                           | What VernLLM does                                                                                               |
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

Fallback, a circuit breaker, a retry budget, rate limiting, and timeouts in one config:

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
});
```

Every target gets its own retries, breaker, limiter, and budget, so a struggling primary can't use up what a healthy fallback needs. Recovery goes through half open trial calls, not a timer, and bad config throws at construction instead of in production.

### Seeing what happened

One `onEvent` stream reports every decision made inside a call:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-6-sol',
  onEvent: (event) => {
    switch (event.kind) {
      case 'retry':
        console.log(`retry ${event.attempt} on ${event.provider} in ${event.delayMs}ms`);
        break;
      case 'circuit_state':
        console.log(`circuit ${event.provider}: ${event.from} -> ${event.to}`);
        break;
      case 'fallback':
        console.log(`fallback ${event.from} -> ${event.to}`);
        break;
    }
  },
});
```

The same stream answers the questions that come up during an incident:

| Question                               | Where the answer is                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Why did this call take 9 seconds?      | `rate_limited` with the wait, `retry` with the delay, `fallback` with time per target |
| Which tenant spent these tokens?       | The call's `context` rides on every event and every usage report                      |
| Were we billed for a call that failed? | A `usage_failure` event and `onUsageFailure`                                          |
| Is a breaker open right now?           | `getCircuitStates()`, `getFailureBreakdown()`, and `getRetryBudgetState()`            |
| What exactly was sent?                 | Every `LLMError` keeps each attempt with a request snapshot, auth headers stripped    |

Errors are typed, with 12 error types and 38 codes, so your code can tell a timeout from a schema failure from an open circuit. [`vern-llm-otel`](./packages/integrations/vern-llm-otel) turns the whole stream into OpenTelemetry traces and metrics.

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

A stream that fails before its first chunk is retried and falls back like any other call.

### Tool calling

VernLLM returns typed tool calls. You run the tools and continue the conversation.

```ts
const result = await llm.call({
  userContent: 'What is the weather in New York?',
  tools: [
    {
      name: 'get_weather',
      description: 'Gets the current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ],
});

if (result.type === 'tool_calls') {
  for (const call of result.toolCalls) console.log(call.name, call.arguments);
}
```

### Middleware

Routing and policy are TypeScript in your repo. A `wrap` can drop or reorder targets, and an inner one can never add back what an outer one removed.

```ts
import type { VernLLMMiddleware } from 'vern-llm';

const residency: VernLLMMiddleware = {
  name: 'residency',
  wrap: (request, next, ctx) =>
    ctx.context?.region === 'eu'
      ? next({ targets: ctx.targets.filter((t) => t.name.startsWith('eu-')).map((t) => t.name) })
      : next(),
};

await llm.call({ userContent, context: { tenantId: 't1', region: 'eu' } });
```

## Why not a gateway

A gateway sees an HTTP request and response. VernLLM sees the call: the schema the answer must pass, the tenant it belongs to, and which providers it may use. That changes three things:

1. **It judges the answer, not the status code.** A 200 with an unusable body is a failure.
2. **It tells your fault from the provider's.** A bad request never opens the circuit for everyone.
3. **It adds nothing that can fail.** No extra network hop, no server to run, and prompts never pass through a third party.

It is not a gateway, dashboard, key manager, pricing table, or agent framework, and it never executes tools for you. If you want those, it works alongside them: point an OpenAI compatible adapter at LiteLLM, Portkey, or the Vercel AI Gateway and pick a single retry owner. VernLLM fits best in TypeScript services where a failed LLM call is an incident.

## Built to be depended on

- **Zero runtime dependencies** in core, so there is nothing transitive to audit.
- **A size cap in CI:** the core bundle must stay under 120 KB, and the adapters entry under 12 KB.
- **Over 2,400 tests in core**, with coverage gates and CodeQL scanning on every change.
- **An overhead benchmark in CI** for core and every extension, which fails when a call gets slower than its baseline.
- **npm provenance** on published packages, and a changeset for every behavior change that spells out what changes at runtime.

## Packages

Everything beyond core is optional and depends only on `vern-llm`, so you install only what you use.

### Adapters

Adapters translate a provider's API into one small `LLMClient` interface, so retries, fallback, rate limiting, and caching behave the same whichever provider is behind a call. They ship inside `vern-llm`, on the `vern-llm/adapters` entry.

| Adapter                                 | Providers                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fromOpenAI` and `fromOpenAICompatible` | OpenAI, plus 36 named providers such as Groq, Mistral, DeepSeek, Cerebras, Together AI, Fireworks AI, Ollama, OpenRouter, xAI, and vLLM, and any OpenAI compatible API |
| `fromAnthropic`                         | Anthropic                                                                                                                                                              |
| `fromGemini`                            | Gemini                                                                                                                                                                 |
| `fromFetch`                             | Any provider reachable over HTTP, with your own URL, headers, and request and response mapping                                                                         |
| `fromBedrock`                           | AWS Bedrock, from the [`vern-llm-bedrock`](./packages/integrations/vern-llm-bedrock) integration because it is built on the AWS SDK client                             |

### Extensions

Extensions add a capability inside the call. Each one is a [middleware](https://vernllm.dev/docs/core/middleware) with a fixed place in the call, so the order you list them in never matters.

| Package                                                    | What it adds                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`vern-llm-logger`](./packages/extensions/vern-llm-logger) | One structured record per call, rolling latency percentiles, slow call alerts   |
| [`vern-llm-usage`](./packages/extensions/vern-llm-usage)   | Estimated cost and wasted spend per call, budgets that reject early             |
| [`vern-llm-router`](./packages/extensions/vern-llm-router) | Target order from rules, health, latency, or cost, with dry run and shadow mode |
| [`vern-llm-policy`](./packages/extensions/vern-llm-policy) | Removes forbidden targets, fails closed, and audits every decision              |
| [`vern-llm-guard`](./packages/extensions/vern-llm-guard)   | Labels, redacts, or blocks what goes into a call and what comes out             |
| [`vern-llm-hedge`](./packages/extensions/vern-llm-hedge)   | Sends a slow call to the next target too and keeps the first answer             |

```ts
import { guardMiddleware, patterns } from 'vern-llm-guard';
import { jsonSink, loggerMiddleware } from 'vern-llm-logger';

const llm = new VernLLM({
  client: openai,
  model: 'gpt-6-sol',
  middleware: [
    loggerMiddleware({ sink: jsonSink() }),
    guardMiddleware({
      version: '2026-10-25.1',
      checks: [{ id: 'secrets', detect: patterns(['secrets']), action: 'block' }],
    }),
  ],
});
```

### Integrations

Integrations connect VernLLM to what lives outside your process. Each one backs an extension point core already exposes, so your calls don't change. Add one when your app runs as more than one process, you want calls in your observability stack, or your provider needs its own SDK.

| Package                                                        | What it connects                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`vern-llm-redis`](./packages/integrations/vern-llm-redis)     | Shares breaker, rate limit, retry budget, and cache state across processes  |
| [`vern-llm-otel`](./packages/integrations/vern-llm-otel)       | OpenTelemetry traces and metrics that follow the GenAI semantic conventions |
| [`vern-llm-bedrock`](./packages/integrations/vern-llm-bedrock) | AWS Bedrock Converse models through the AWS SDK's own client                |

### Better together

Every package stands alone, and some combinations are worth reaching for:

- **Privacy by routing (guard, policy):** the guard finds PII and policy removes every target that may not see it, failing closed if the guard didn't run.
- **A budget per tenant for the whole fleet (usage, Redis):** limits are checked before a provider is contacted and shared across every process.
- **Routing that tunes itself (router, logger):** targets are ranked by measured latency, failure rate, and cost, with shadow mode to check the picks first.

See the docs for [adapters](https://vernllm.dev/docs/adapters), [extensions](https://vernllm.dev/docs/extensions), and [integrations](https://vernllm.dev/docs/integrations).

## Contributing

Contributions are welcome. See [CONTRIBUTING](./.github/CONTRIBUTING.md), the [security policy](./.github/SECURITY.md), and the [code of conduct](./.github/CODE_OF_CONDUCT.md). Questions and ideas go in [issues](https://github.com/LakBud/vernLLM/issues), and release notes live in the [changelog](./packages/vern-llm/CHANGELOG.md).

This is a pnpm monorepo managed with [Nx](https://nx.dev): packages live in [`packages/`](./packages) and the docs site in [`apps/docs`](./apps/docs).

## License

[MIT](./LICENSE.md) © LakBud
