<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/banner.png" alt="VernLLM banner" />
</p>

<p align="center">
  <a href="https://vernllm.vercel.app">Documentation</a> ·
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
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/codeql.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/codeql.yml/badge.svg" alt="codeql status" /></a>
  <a href="https://www.bestpractices.dev/projects/14212"><img src="https://www.bestpractices.dev/projects/14212/badge"></a>
  <a href="./LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white" alt="pnpm monorepo" />
</p>

<p align="center">The LLM call framework. Resilience, observability, and control for every call.</p>

<p align="center">Retries, timeouts, circuit breaking, provider fallback, rate limiting, caching, middleware plug-ins, structured output, usage metering, usage tracking, observability events and even more, with one interface across OpenAI-compatible, Anthropic, Gemini, and Bedrock providers.</p>

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { fromAnthropic, fromOpenAI, VernLLM } from 'vern-llm';

const llm = new VernLLM({
  client: fromOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })),
  model: 'gpt-4o',
  maxRetries: 3,
  timeoutMs: 10_000,
  baseDelayMs: 500,
  nonRetryableStatus: [400, 401, 403, 404, 422],
  defaultMaxTokens: 1000,
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 30_000,
  },
  rateLimit: {
    requestsPerMinute: 500,
    maxConcurrent: 20,
  },
  fallback: {
    client: fromAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })),
    model: 'claude-sonnet-5',
    circuitBreaker: true,
  },
  onUsage: (u) => {
    console.log(`${u.requestId}: ${u.totalTokens} tokens used`);
  },
  onEvent: (event) => {
    if (event.kind === 'fallback') console.warn(`falling over ${event.from} -> ${event.to}`);
  },
  debug: false,
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
    requestId: 'weather-demo-001',
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

Works with OpenAI, Groq, Mistral, DeepSeek, Cerebras, Together AI, Fireworks AI, Ollama, Anthropic, Gemini, AWS Bedrock, or any provider reachable over HTTP via a `fromFetch` adapter.

## Repository layout

This is a pnpm monorepo with two workspaces:

| Path                                       | Description                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [`packages/vern-llm`](./packages/vern-llm) | The `vern-llm` npm package: source, tests, and its own README with the full API reference. |
| [`apps/docs`](./apps/docs)                 | The [Fumadocs](https://fumadocs.dev)-powered documentation site.                           |

## Root scripts

| Command                        | Description                                          |
| ------------------------------ | ---------------------------------------------------- |
| `pnpm build`                   | Build every workspace package (`--if-present`).      |
| `pnpm build:package`           | Build just `vern-llm`.                               |
| `pnpm build:docs`              | Build just the docs site.                            |
| `pnpm dev`                     | Run dev mode across every workspace package.         |
| `pnpm dev:package`             | Watch-build `vern-llm` (`tsdown --watch`).           |
| `pnpm dev:docs`                | Run the docs site locally (`next dev`).              |
| `pnpm typecheck`               | Typecheck every workspace package.                   |
| `pnpm test`                    | Run the `vern-llm` test suite (`vitest run`).        |
| `pnpm test:coverage`           | Run tests with coverage (v8 provider).               |
| `pnpm lint` / `lint:fix`       | Lint the whole repo with [oxlint](https://oxc.rs/).  |
| `pnpm format` / `format:check` | Format the whole repo with [oxfmt](https://oxc.rs/). |
| `pnpm changeset`               | Record a changeset for the next `vern-llm` release.  |

## License

[MIT](./LICENSE.md) © LakBud
