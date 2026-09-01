# Contributing to vernLLM

The full guide lives in the docs: [Contributing](https://vernllm.dev/docs/contributing) (or [apps/docs/content/docs/contributing.mdx](https://github.com/LakBud/vernLLM/blob/main/apps/docs/content/docs/contributing.mdx) if browsing the repo).

Quick start:

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run typecheck:test
pnpm run test
```

Record your change with `pnpm run changeset` before opening a PR.
If it doesn't need a release, run `pnpm run changeset add --empty` instead of skipping it, CI checks for one.

Security issue? See [SECURITY.md](./SECURITY.md) instead of opening a public issue. Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).
