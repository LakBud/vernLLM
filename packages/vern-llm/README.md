<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/logo.png" alt="vern-llm logo" width="96" />
</p>

<h1 align="center">vern-llm</h1>

<p align="center">
  <a href="https://github.com/LakBud/vernLLM">GitHub</a> ·
  <a href="https://vernllm.dev">Documentation</a> ·
  <a href="https://www.npmjs.com/package/vern-llm">npm</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/v/vern-llm.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/dm/vern-llm.svg" alt="npm downloads" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/build-checks.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/build-checks.yml/badge.svg" alt="build checks status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/typecheck.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/typecheck.yml/badge.svg" alt="typecheck status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/test-unit.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/test-unit.yml/badge.svg" alt="unit test status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/test-integration.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/test-integration.yml/badge.svg" alt="integration test status" /></a>
  <a href="https://codecov.io/gh/LakBud/vernLLM" ><img src="https://codecov.io/gh/LakBud/vernLLM/graph/badge.svg?token=NKKW54MODY"/></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/lint.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/lint.yml/badge.svg" alt="lint status" /></a>
  <a href="https://github.com/LakBud/vernLLM/blob/main/LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/node/v/vern-llm.svg" alt="node version" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

<p align="center">The LLM call framework. Resilience, observability, and control for every call, in your own process.</p>

The `vern-llm` npm package: one client across OpenAI-compatible, Anthropic, Gemini, and Bedrock, with retries, circuit breaking, fallback, rate limiting, caching, and middleware built in.

**Full documentation: [vernllm.dev](https://vernllm.dev)** for installation, structured output, caching, circuit breaker, provider fallback, rate limiting, observability, every adapter, and the complete API reference. This README is a quick reference, not the manual.

## Install

```bash
pnpm add vern-llm
```

## Quick start

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fromAnthropic, fromOpenAI, VernLLM } from 'vern-llm';

const openai = fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
const anthropic = fromAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  fallback: { client: anthropic, model: 'claude-sonnet-5', circuitBreaker: true },
  rateLimit: { requestsPerMinute: 500, tokensPerMinute: 100_000, maxConcurrent: 20 },
  retryBudget: { windowMs: 60_000, minCalls: 20, retryRatio: 0.2 },
  maxRetries: 3,
  timeoutMs: 10_000,
  defaultMaxTokens: 1000,
  defaultReasoningEffort: 'medium',
});

const result = await llm.call({ userContent: "What's the weather in New York?" });
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
- **Middleware pipeline**: `transform` patches the outgoing request per attempt, `wrap` runs once around the whole logical call regardless of retries or fallback, patches from separate middleware merge instead of clobbering each other, order is controlled by `priority`, and each entry can be conditionally `enabled` per call
- **Circuit breaker**: trips after repeated failures, recovers automatically once the provider's back, independent per fallback target too
- **Observability**: one `onEvent` stream reports retries, fallovers, circuit transitions, and rate-limit waits
- **Usage tracking**: `onUsage` and `onUsageFailure` report token spend on success and on failure, so nothing goes unaccounted for when a call fails after the provider already responded
- **One interface, every provider**: OpenAI, Groq, Mistral, DeepSeek, Cerebras, Together, Fireworks, Ollama, Anthropic, Gemini, Bedrock, or raw HTTP via `fromFetch`
- **Zero runtime dependencies**: `zod` and provider SDKs are not required dependencies; vern-llm relies on compatible interfaces rather than specific implementations.

### Why not a gateway?

The customization is something a gateway can't match. vern-llm runs in your process, so you bring your own rate limiter, cache, and middlewares which transform the call instead of picking from a config panel, and hooks like `reserveUsage`, `onEvent` and even more give you superior control over billing and observability.

See the [docs](https://vernllm.dev) for adapter setup, caching, the circuit breaker, provider fallback, rate limiting, and structured output in depth.

## License

[MIT](https://github.com/LakBud/vernLLM/blob/main/LICENSE.md) © LakBud
