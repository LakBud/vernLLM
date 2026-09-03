<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/banner.png" alt="VernLLM banner" />
</p>

<p align="center">
  <a href="https://vernllm.dev">Documentation</a> ·
  <a href="https://npmjs.com/package/vern-llm">npm</a> ·
  <a href="./packages/vern-llm">Package</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/v/vern-llm.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/dm/vern-llm.svg" alt="npm downloads" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/build-checks.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/build-checks.yml/badge.svg" alt="build checks status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/lint.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/lint.yml/badge.svg" alt="lint status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/typecheck.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/typecheck.yml/badge.svg" alt="typecheck status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/test-unit.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/test-unit.yml/badge.svg" alt="unit test status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/test-integration.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/test-integration.yml/badge.svg" alt="integration test status" /></a>
  <a href="https://codecov.io/gh/LakBud/vernLLM" ><img src="https://codecov.io/gh/LakBud/vernLLM/graph/badge.svg?token=NKKW54MODY"/></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/codeql.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/codeql.yml/badge.svg" alt="codeql status" /></a>
  <a href="https://www.bestpractices.dev/projects/14212"><img src="https://www.bestpractices.dev/projects/14212/badge"></a>
  <a href="./LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white" alt="pnpm monorepo" />
</p>

<p align="center">The LLM call framework. Resilience, observability, and control for every call.</p>

<p align="center">One interface across OpenAI-compatible, Anthropic, Gemini, and Bedrock, with retries, circuit breaking, provider fallback, rate limiting, caching, and middleware built in, all running in your own process rather than a new network hop.</p>

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

Works with OpenAI, Groq, Mistral, DeepSeek, Cerebras, Together AI, Fireworks AI, Ollama, Anthropic, Gemini, AWS Bedrock, or any provider reachable over HTTP via a `fromFetch` adapter.

## Repository layout

This is a pnpm monorepo with two workspaces:

| Path                                       | Description                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [`packages/vern-llm`](./packages/vern-llm) | The `vern-llm` npm package: source, tests, and its own README with the full API reference. |
| [`apps/docs`](./apps/docs)                 | The [Fumadocs](https://fumadocs.dev)-powered documentation site.                           |

## License

[MIT](./LICENSE.md) © LakBud
