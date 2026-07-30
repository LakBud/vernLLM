<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/banner.png" alt="VernLLM banner" />
</p>

<p align="center">
  <a href="https://vernllm.vercel.app">Documentation</a> ·
  <a href="./packages/vern-llm">Package</a>
</p>

<p align="center">
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/test.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/test.yml/badge.svg" alt="test status" /></a>
  <a href="https://github.com/LakBud/vernLLM/actions/workflows/lint.yml"><img src="https://github.com/LakBud/vernLLM/actions/workflows/lint.yml/badge.svg" alt="lint status" /></a>
  <a href="https://www.npmjs.com/package/vern-llm"><img src="https://img.shields.io/npm/v/vern-llm.svg" alt="npm version" /></a>
  <a href="./LICENSE.md"><img src="https://img.shields.io/npm/l/vern-llm.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white" alt="pnpm monorepo" />
</p>

<p align="center">A lightweight resilience layer for LLM chat completions; retries, timeouts, circuit breaking, caching, structured output, and usage tracking, with one interface across OpenAI-compatible, Anthropic, Gemini, and Bedrock providers.</p>

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

Works with OpenAI, Groq, Mistral, DeepSeek, Cerebras, Together AI, Fireworks AI, Ollama, Anthropic, Gemini, AWS Bedrock, or any provider reachable over HTTP via a `fromFetch` adapter.

## Repository layout

This is a pnpm monorepo with two workspaces:

| Path                                       | Description                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`packages/vern-llm`](./packages/vern-llm) | The `vern-llm` npm package — source, tests, and its own README with the full API reference. |
| [`apps/docs`](./apps/docs)                 | The [Fumadocs](https://fumadocs.dev)-powered documentation site.                            |

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
