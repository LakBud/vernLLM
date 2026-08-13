<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/logo.png" alt="vern-llm logo" width="96" />
</p>

<h1 align="center">vern-llm</h1>

<p align="center">
  <a href="https://github.com/LakBud/vernLLM">GitHub</a> ·
  <a href="https://vernllm.vercel.app">Documentation</a> ·
  <a href="https://www.npmjs.com/package/vern-llm">npm</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/v/vern-llm.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/dm/vern-llm.svg" alt="npm downloads" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/test.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/test.yml/badge.svg" alt="test status" /></a>
  <a href="https://github.com/LakBud/vernLLM/blob/main/LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/node/v/vern-llm.svg" alt="node version" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

<p align="center">Production-ready resilience for LLM calls</p>

Retries, timeouts, caching, circuit breaking, provider fallback, and client-side rate limiting behind one typed interface, with adapters for OpenAI-compatible APIs (OpenAI, Groq, and more), Anthropic, Gemini, and Bedrock.

**Full documentation: [vernllm.vercel.app](https://vernllm.vercel.app)** — installation, structured output, caching, circuit breaker, provider fallback, rate limiting, observability, every adapter, and the complete API reference all live there and are kept up to date. This README is a quick pitch, not the manual.

## Install

```bash
pnpm add vern-llm
```

## Quick start

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fromAnthropic, VernLLM } from 'vern-llm';

const llm = new VernLLM({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4o',
  maxRetries: 3,
  timeoutMs: 10_000,
  circuitBreaker: true,
  rateLimit: { requestsPerMinute: 500, maxConcurrent: 20 },
  fallback: {
    client: fromAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })),
    model: 'claude-sonnet-5',
    circuitBreaker: true,
  },
  onEvent: (event) => {
    if (event.kind === 'fallback') console.warn(`falling over ${event.from} -> ${event.to}`);
  },
});

const getWeather = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const { chunks, finalResult } = await llm.cachedCall({
  cacheKey: 'weather-demo-001',
  ttl: 60,
  call: {
    userContent: "What's the weather in New York?",
    tools: [getWeather],
    stream: true,
  },
});

for await (const chunk of chunks) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
}

const result = await finalResult; // cached, retried, and streamed, tool calls included
```

## Why vern-llm?

- **Retries with backoff**: transient failures retry automatically; validation errors and non-retryable status codes fail fast instead
- **Provider fallback**: declare an ordered list of backup targets, tried in order after the primary, with no scoring or health-checking, `fallback` on the same constructor
- **Client-side rate limiting**: queue locally against requests-per-minute, tokens-per-minute, and concurrency ceilings instead of letting the provider reject the call
- **Structured output**: pass a Zod schema, get a typed, validated result back
- **Tool calling**: pass `tools`, vern-llm handles retries and validation around them the same as any other call; you run the tools and continue the conversation
- **Streaming**: set `stream: true` on any call and get live chunks alongside the same validated result the call would otherwise resolve to
- **Provider-native JSON Schema mode**: constrain generation itself, not just validate after the fact
- **Caching**: wrap any LLM call with `cachedCall`, bring your own cache adapter
- **Circuit breaker**: trips after repeated failures, recovers automatically once the provider's back, independent per fallback target too
- **Observability**: one `onEvent` stream reports retries, fallovers, circuit transitions, and rate-limit waits
- **Usage tracking**: `onUsage` and `onUsageFailure` report token spend on success and on failure, so nothing goes unaccounted for when a call fails after the provider already responded
- **One interface, every provider**: OpenAI, Groq, Mistral, DeepSeek, Cerebras, Together, Fireworks, Ollama, Anthropic, Gemini, Bedrock, or raw HTTP via `fromFetch`
- **Zero runtime dependencies**: `zod` and provider SDKs are not required dependencies; vern-llm relies on compatible interfaces rather than specific implementations.

See the [docs](https://vernllm.vercel.app) for adapter setup, caching, the circuit breaker, provider fallback, rate limiting, and structured output in depth.

## License

[MIT](https://github.com/LakBud/vernLLM/blob/main/LICENSE.md) © LakBud
