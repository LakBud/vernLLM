<p align="center">
  <img src="./public/logo.png" alt="vern-llm logo" width="96" />
</p>

<h1 align="center">vern-llm-docs</h1>

<p align="center">
  <a href="https://vernllm.vercel.app"><img src="https://img.shields.io/website?url=https%3A%2F%2Fvernllm.vercel.app&label=docs%20site" alt="docs site status" /></a>
  <a href="https://vernllm.vercel.app"><img src="https://img.shields.io/badge/deployed%20on-Vercel-000000?logo=vercel&logoColor=white" alt="Deployed on Vercel" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/Fumadocs-16-6366F1" alt="Fumadocs" />
</p>

<p align="center">The documentation site for <a href="../../packages/vern-llm"><code>vern-llm</code></a>, built with <a href="https://nextjs.org">Next.js</a> and <a href="https://fumadocs.dev">Fumadocs</a> (scaffolded with Create Fumadocs). Deployed on <a href="https://vercel.com">Vercel</a> at <a href="https://vernllm.vercel.app">vernllm.vercel.app</a>.</p>

## Development

From the repo root:

```bash
pnpm dev:docs
```

Or from this directory:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the site.

## Content

Docs pages live in [`content/docs`](./content/docs) as MDX, organized by section:

| Section                                                     | Contents                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`getting-started.mdx`](./content/docs/getting-started.mdx) | Install and make your first call.                                                                   |
| [`core/`](./content/docs/core)                              | Structured output, caching, circuit breaker, error handling, cancellation, logging, usage tracking. |
| [`adapters/`](./content/docs/adapters)                      | OpenAI-compatible providers, Anthropic, Gemini, Bedrock, and the raw-fetch escape hatch.            |
| [`guides/`](./content/docs/guides)                          | End-to-end walkthroughs (resume parsing, provider fallback).                                        |
| [`reference/`](./content/docs/reference)                    | Development setup notes and miscellaneous reference.                                                |
| [`changelog.mdx`](./content/docs/changelog.mdx)             | Release notes.                                                                                      |

Each folder has a `meta.json` controlling sidebar ordering. Edit or add `.mdx` files there and the site picks them up automatically.

## Project structure

- `src/app` — Next.js App Router routes: `(home)` for the landing page, `docs` for the documentation layout, `api/search/route.ts` for the search endpoint.
- `src/lib/source.ts` — the content source adapter; Fumadocs' [`loader()`](https://fumadocs.dev/docs/headless/source-api) exposes the MDX content to the app.
- `src/lib/layout.shared.tsx` — shared layout options used across routes.
- `source.config.ts` — Fumadocs MDX configuration (frontmatter schema, etc.) — see the [MDX introduction](https://fumadocs.dev/docs/mdx) for details.

## Scripts

| Command            | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `pnpm dev`         | Start the dev server.                                              |
| `pnpm build`       | Production build.                                                  |
| `pnpm start`       | Serve the production build.                                        |
| `pnpm types:check` | Regenerate Fumadocs MDX types and Next types, then `tsc --noEmit`. |
| `pnpm lint`        | Lint with oxlint.                                                  |

## Learn more

- [Next.js documentation](https://nextjs.org/docs)
- [Fumadocs documentation](https://fumadocs.dev)
- [`vern-llm` package README](../../packages/vern-llm/README.md) — the full API reference this site documents
