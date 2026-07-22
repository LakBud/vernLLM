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

<p align="center">A lightweight resilience layer for OpenAI-compatible chat completion calls — retries, timeouts, circuit breaking, caching, structured output, and usage tracking, with one interface across providers.</p>

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

## Getting started

Requires Node 22.13+ and [pnpm](https://pnpm.io/) (this repo pins `pnpm@11.15.0`).

```bash
pnpm install
```

Common scripts, runnable from the repo root:

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

See [`packages/vern-llm/README.md`](./packages/vern-llm/README.md) for the complete API — installation, structured output, provider adapters, caching, circuit breaker, and more — and the [docs site](https://vernllm.dev) (or run `pnpm dev:docs` locally) for the full guided documentation.

## Contributing

1. Fork and clone the repo, then `pnpm install` at the root.
2. Make your change inside `packages/vern-llm` (library code) or `apps/docs` (documentation).
3. Add tests for library changes — see the [Development section](./packages/vern-llm/README.md#development) of the package README for how the test suite is organized.
4. Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before opening a PR.
5. If your change affects the published package, add a changeset: `pnpm changeset`.

## License

[MIT](./LICENSE.md) © LakBud
