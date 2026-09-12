# Changesets

This repository uses Changesets to manage versioning and releases.

## Adding a changeset

When making a user-facing change, add a changeset before opening a pull request:

```bash
pnpm changeset
```

Choose:

- **patch**: bug fixes and small improvements
- **minor**: new features or backwards-compatible changes
- **major**: breaking changes

IMPORTANT: Currently some breaking changes will be on minor changes

Write a short summary explaining what changed and why.

## Changeset format

A changeset file has a YAML frontmatter block naming the package and bump type, then the release note body:

```md
---
'vern-llm': minor
---

One sentence summary of what changed and why.
```

Keep the body to this shape:

- First paragraph: what changed, in plain terms a user of the package would understand.
- A `ts` code block showing before/after usage, only when the change is visible in code a caller writes.
- A closing line stating the practical impact. Say plainly whether existing code keeps compiling and keeps behaving the same at runtime. Don't write "Purely additive" if a type level change (e.g. a new member on an exported union) can break an exhaustive `switch`, say that instead.

If the change is breaking enough to need migration steps, add a matching entry to [Migration Notes](/docs/migration-notes) and link it from the changeset body.

## Release process

Changesets are reviewed with pull requests. When changesets are merged, they are used to generate releases and changelogs automatically and is updated within the documentation websites changelog

## What needs a changeset?

Add one for:

- New features
- Bug fixes affecting users
- API changes
- Model/provider changes
- Configuration changes

Do not add changesets for:

- Documentation-only changes
- Formatting changes
- CI/workflow changes

CI checks every PR touching `packages/vern-llm` for a changeset. If your change doesn't need a release, run `pnpm changeset add --empty` instead of skipping it.
