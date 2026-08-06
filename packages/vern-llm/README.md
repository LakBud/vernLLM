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
  <a href="https://bundlephobia.com/package/vern-llm"><img src="https://img.shields.io/bundlephobia/minzip/vern-llm.svg" alt="bundle size" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/test.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/test.yml/badge.svg" alt="test status" /></a>
  <a href="https://github.com/LakBud/vernLLM/blob/main/LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/node/v/vern-llm.svg" alt="node version" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

<p align="center">Production-ready resilience for LLM calls</p>

Retries, timeouts, caching, and circuit breaking behind one typed interface, with adapters for OpenAI-compatible APIs (OpenAI, Groq, and more), Anthropic, Gemini, and Bedrock.

**Full documentation: [vernllm.vercel.app](https://vernllm.vercel.app)** — installation, structured output, caching, circuit breaker, every adapter, and the complete API reference all live there and are kept up to date. This README is a quick pitch, not the manual.

## Install

```bash
pnpm add vern-llm
```

## Quick start

```ts
import OpenAI from 'openai';
import { VernLLM } from 'vern-llm';

const llm = new VernLLM({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4o',
  maxRetries: 3,
  timeoutMs: 10_000,
  circuitBreaker: true,
});

const result = await llm.call({
  systemPrompt: 'Return JSON: { "skills": string[] }',
  userContent: 'Extract skills from: ...',
});
```

## Why vern-llm?

- **Retries with backoff**: transient failures retry automatically; validation errors and non-retryable status codes fail fast instead
- **Structured output**: pass a Zod schema, get a typed, validated result back
- **Provider-native JSON Schema mode**: constrain generation itself, not just validate after the fact
- **Caching**: wrap any call with `cachedCall`, bring your own cache adapter
- **Circuit breaker**: trips after repeated failures, recovers automatically once the provider's back
- **One interface, every provider**: OpenAI, Groq, Mistral, DeepSeek, Cerebras, Together, Fireworks, Ollama, Anthropic, Gemini, Bedrock, or raw HTTP via `fromFetch`
- **Zero runtime dependencies**: `zod` and provider SDKs are not required dependencies; VernLLM relies on compatible interfaces rather than specific implementations.

See the [docs](https://vernllm.vercel.app) for adapter setup, caching, the circuit breaker, and structured output in depth.

## License

[MIT](https://github.com/LakBud/vernLLM/blob/main/LICENSE.md) © LakBud
