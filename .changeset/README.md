# Changesets

This repository uses Changesets to manage versioning and releases.

## Adding a changeset

When making a user-facing change, add a changeset before opening a pull request:

```bash
pnpm changeset
```

Choose:

- **patch** — bug fixes and small improvements
- **minor** — new features or backwards-compatible changes
- **major** — breaking changes

Write a short summary explaining what changed and why.

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
- Internal refactors
- Formatting changes
