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
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/ci.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://codecov.io/gh/LakBud/vernLLM" ><img src="https://codecov.io/gh/LakBud/vernLLM/graph/badge.svg?token=NKKW54MODY"/></a>
  <a href="https://github.com/LakBud/vernLLM/blob/main/LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/node/v/vern-llm.svg" alt="node version" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

<p align="center">The LLM call framework. Resilience, observability, and control for every call, in your own process.</p>

**Full documentation: [vernllm.dev](https://vernllm.dev)** for installation, every adapter, and the complete API reference. This README is a quick reference, not the manual.

## Install

```bash
npm i vern-llm
```

## Quick start

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { VernLLM } from 'vern-llm';
import { fromAnthropic, fromOpenAI } from 'vern-llm/adapters';

const openai = fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 }));
const anthropic = fromAnthropic(
  new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 }),
);

const llm = new VernLLM({
  client: openai,
  model: 'gpt-6-sol',
  fallback: { client: anthropic, model: 'claude-sonnet-5-5', circuitBreaker: true },
  rateLimit: { requestsPerMinute: 500, tokensPerMinute: 100_000, maxConcurrent: 20 },
  retryBudget: { windowMs: 60_000, minCalls: 20, retryRatio: 0.2 },
  maxRetries: 3,
  timeoutMs: 10_000,
  defaultMaxTokens: 1000,
  defaultReasoningEffort: 'medium',
});

const result = await llm.call({ userContent: "What's the weather in New York?" });
```

Pass `maxRetries: 0` to provider SDKs so vern-llm is the only retry authority.

## Resilience

Calls keep working when providers fail, and a failing provider can't take your app down with it.

- **Retries**: full jitter backoff that honors `Retry-After` up to your cap. Validation and caller errors fail fast
- **Retry budget**: caps retries at a share of each target's traffic, so an outage can't turn into a retry storm
- **Circuit breaker per target**: consecutive, rolling, or custom tripping, with half open trials and a success ratio for recovery. Caller errors never open it
- **Soft failures**: an empty body, JSON cut off at `max_tokens`, a stream that fails before its first chunk, or anything `detectSoftFailure` flags counts as a failure, even behind a 200
- **Ordered fallback**: each target gets its own retries, breaker, limiter, and budget. When every target is open, the call fails fast with `FallbackExhaustedError`
- **Client side rate limiting**: requests, tokens, and concurrency per target, with a wait queue that adapts after or ahead of a 429
- **Timeouts**: per attempt, whole call via `deadlineMs`, stream idle, and reader stall
- **Caching**: `cachedCall` shares one provider call across concurrent misses, treats a failing cache as a miss, and never caches a failed call

## Observability

Every retry, fallback, wait, and breaker change is reported, tied to the call and the tenant that caused it.

- **One event stream**: `onEvent` reports retries, fallbacks, breaker transitions, rate limit waits, usage, and middleware events from `ctx.emit`
- **Usage on success and failure**: `onUsage` and `onUsageFailure`, with prompt cache reads and writes split out
- **Typed errors**: every `LLMError` carries a code and each attempt with its request snapshot, auth headers stripped
- **Live health state**: `getCircuitStates()`, `getFailureBreakdown()`, `getRetryBudgetState()`, and `readRateLimitState()`
- **OpenTelemetry**: [`vern-llm-otel`](https://www.npmjs.com/package/vern-llm-otel) turns events into GenAI traces and metrics in your own setup

## Control

Your code decides which providers a call may use, in what order, and when to give up.

- **Per call targets**: `targets: ['bedrock', 'primary']` picks the providers and order for one call
- **Middleware**: `transform` patches each attempt, `wrap` runs once around the whole call, and `dispatch` sees the final request. Order it with `priority`, `runsAfter`, and `runsBefore`
- **Policy that only narrows**: a `wrap` can drop or reorder targets through `next({ targets })`, and an inner one can never add back what an outer one removed
- **Fallback decisions**: `fallbackOn` sees the error, the failed target, and the next one
- **Call scoped data**: `context` reaches every hook, event, and usage report
- **Manual breakers**: `openCircuit()` and `closeCircuit()` per target
- **No surprises**: vern-llm never reorders targets on its own, and bad config throws at construction

## Also included

- **Structured output** with any validator or provider native JSON Schema mode
- **Tool calling** with typed calls. You run the tools and continue the conversation
- **Streaming** with `stream: true`, returning live chunks and the same validated result
- **Adapters** for OpenAI compatible providers, Anthropic, Gemini, Bedrock (via `vern-llm-bedrock`), and raw HTTP via `fromFetch`
- **Shared state across processes** for the breaker, rate limits, and cache via `vern-llm-redis`
- **Zero runtime dependencies**. `zod` and provider SDKs are optional

## Why not a gateway?

A gateway sees an HTTP request and response. vern-llm sees the call: the schema the answer must pass, the tenant it belongs to, and which providers it may use. So it judges the answer instead of the status code, tells your fault from the provider's, and adds no network hop, no server, and no third party in the path of your prompts.

It is not a gateway, dashboard, key manager, pricing table, or agent framework, and it never executes tools for you. It works alongside one: point an OpenAI compatible adapter at LiteLLM, Portkey, or `fromVercelAIGateway`, and pick one retry owner.

See [Why VernLLM](https://vernllm.dev/docs/why) for the full comparison with the AI SDK, LiteLLM, and Portkey.

## License

[MIT](https://github.com/LakBud/vernLLM/blob/main/LICENSE.md) © LakBud
