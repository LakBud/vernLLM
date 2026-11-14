<p align="center">
  <img src="./public/logo.png" alt="vern-llm logo" width="96" />
</p>

<h1 align="center">vern-llm-docs</h1>

<p align="center">
  <a href="https://vernllm.dev"><img src="https://img.shields.io/website?url=https%3A%2F%2Fvernllm.dev&label=docs%20site" alt="docs site status" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/Fumadocs-16-6366F1" alt="Fumadocs" />
</p>

<p align="center">The documentation site for <a href="../../packages/vern-llm"><code>vern-llm</code></a>, built with <a href="https://nextjs.org">Next.js</a> and <a href="https://fumadocs.dev">Fumadocs</a> (scaffolded with Create Fumadocs). Deployed at <a href="https://vernllm.dev">vernllm.dev</a>.</p>

Most people meet VernLLM here before they read a line of its source, so a page that is wrong or out of date misleads them from the start. Everything on the site is MDX in this folder, and a page you edit shows up locally in seconds.

## Quick start

From the repo root:

```bash
pnpm install
pnpm dev:docs
```

Open [http://localhost:3000](http://localhost:3000). Edits to any `.mdx` file reload on save.

## Adding or changing a page

1. Add or edit an `.mdx` file under [`content/docs`](./content/docs). Each page starts with frontmatter:

   ```mdx
   ---
   title: Retries
   description: Exponential backoff with jitter, Retry-After awareness, and what gets retried
   ---
   ```

2. For a new page, add its file name to the `pages` list in that folder's `meta.json`, which controls the sidebar order.
3. Link to other pages with site paths such as `/docs/core/retries#sdk-internal-retries`.
4. Run the checks below before opening a pull request.

## Checks

CI runs all of these on every pull request that touches the docs, so running them first saves a round trip:

| Command            | What it catches                                                    |
| ------------------ | ------------------------------------------------------------------ |
| `pnpm links:check` | An internal `/docs/...` link whose page or `#anchor` doesn't exist |
| `pnpm types:check` | Broken MDX or frontmatter, and type errors in the app              |
| `pnpm lint`        | Lint errors, with oxlint                                           |
| `pnpm test`        | Failures in the link checker and SEO tests                         |
| `pnpm build`       | Anything that only breaks in a production build                    |

Run them from this directory. `pnpm dev` and `pnpm start` run the dev server and serve a production build.

## Where content lives

| Section                                          | Contents                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`index.mdx`](./content/docs/index.mdx)          | Getting started: install and make your first call                                               |
| [`about.mdx`](./content/docs/about.mdx)          | What VernLLM is and the principles behind it                                                    |
| [`why.mdx`](./content/docs/why.mdx)              | The comparison with the AI SDK, LiteLLM, and Portkey                                            |
| [`core/`](./content/docs/core)                   | Fallback, circuit breaker, retry budget, rate limiting, caching, observability, and more        |
| [`adapters/`](./content/docs/adapters)           | OpenAI compatible providers, Anthropic, Gemini, and the raw fetch escape hatch                  |
| [`extensions/`](./content/docs/extensions)       | Logger, usage, router, policy, guard, and hedge                                                 |
| [`integrations/`](./content/docs/integrations)   | Redis, OpenTelemetry, and Bedrock                                                               |
| [`customization/`](./content/docs/customization) | Custom middleware, breakers, caches, rate limiters, tokenizers, schemas, providers, and loggers |
| [`guides/`](./content/docs/guides)               | End to end walkthroughs: fallback patterns, tuning, caching methods, streaming, tool loops      |
| [`API-reference/`](./content/docs/API-reference) | Call params, instance configuration, and reference notes                                        |

Two things to know before editing:

- **Changelog pages are generated.** Every `changelog.mdx` is written from Changesets releases when a package is published, so a hand edit is overwritten. Change the release note in a [changeset](../../.changeset/README.md) instead.
- **A comparison needs a source.** `why.mdx` states the versions it was checked against. Update that note when you change a claim about another tool.

## Project structure

| Path                                   | What it is                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/app/(home)`                       | The landing page                                                                                                     |
| `src/app/docs`                         | The documentation layout and page route                                                                              |
| `src/app/changelog`                    | The changelog page                                                                                                   |
| `src/app/llms.txt` and `llms-full.txt` | The docs as plain text for LLMs                                                                                      |
| `src/app/og`                           | Social images                                                                                                        |
| `src/app/api/search`                   | Search                                                                                                               |
| `src/lib/source.ts`                    | The content source: Fumadocs' [`loader()`](https://fumadocs.dev/docs/headless/source-api) exposes the MDX to the app |
| `src/components`                       | MDX components such as the verdict tables, the search dialog, and UI primitives                                      |
| `source.config.ts`                     | Fumadocs MDX configuration, including the frontmatter schema                                                         |
| `scripts/check-links.ts`               | The link checker behind `pnpm links:check`                                                                           |

## Learn more

- [Next.js documentation](https://nextjs.org/docs)
- [Fumadocs documentation](https://fumadocs.dev)
- [Contributing guide](../../.github/CONTRIBUTING.md)
