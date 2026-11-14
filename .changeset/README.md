# Changesets

A changeset is a small Markdown file that says which packages a pull request changes, how much to bump them, and what to tell users. Its text becomes the release note on npm, in the GitHub Release, and on the docs changelog, word for word. So it is the one thing most users will ever read about your change, and worth a minute of care.

## Quick start

```bash
pnpm changeset
```

Pick the packages you changed, pick a bump for each, and write the summary. This adds a file to `.changeset/`. Commit it with your pull request.

If your change doesn't need a release, run this instead of skipping the step:

```bash
pnpm changeset add --empty
```

CI checks every pull request that touches `packages/vern-llm`, `packages/extensions`, or `packages/integrations` for a changeset, and fails without one.

## Does my change need one?

| Needs a changeset           | Use an empty one           |
| --------------------------- | -------------------------- |
| New features                | Documentation only changes |
| Bug fixes that affect users | Formatting changes         |
| API changes                 |                            |
| Model or provider changes   |                            |
| Configuration changes       |                            |

Pull requests that only touch the docs site, workflows, or the repo root don't trigger the check at all.

## Which bump?

| Bump      | Use it for                                    |
| --------- | --------------------------------------------- |
| **patch** | Bug fixes and small improvements              |
| **minor** | New features and backwards compatible changes |
| **major** | Breaking changes                              |

**Important:** some breaking changes currently ship in a minor release. When yours does, say so in the first line of the changeset so nobody upgrades into it by surprise.

## Writing a good one

A changeset has a frontmatter block naming each package and its bump, then the release note:

```md
---
'vern-llm': minor
---

A provider refusal with no content now fails once with the code `model_refused`, instead of retrying and falling back.

Before, the call was retried, billed again, and answered by a fallback provider. Existing code keeps compiling. A call that used to fall back on a refusal now throws, so catch `model_refused` where you want to show the user a refusal.
```

Keep the body to this shape:

1. **What changed**, in plain terms a user of the package would understand. Name the option, method, or error code.
2. **A `ts` code block** showing before and after, whenever the change is visible in code a caller writes. See below.
3. **The practical impact.** Say plainly whether existing code keeps compiling and keeps behaving the same at runtime.

### Show the code for API changes

When a change touches the API (a new option, a renamed method, a changed return shape, a new error code to catch), a code example is the most important part of the changeset. A reader upgrading wants to know what to type, and a sentence like "`retryBudget` now accepts an adapter" leaves them to work it out from the types. A before and after block answers it at a glance, and it is the part people copy.

````md
---
'vern-llm': minor
---

`retryBudget` accepts a `RetryBudgetAdapter`, so one budget can be shared across processes.

```ts
// Before: options only, one budget per process
new VernLLM({ client, model, retryBudget: { windowMs: 60_000, minCalls: 20, retryRatio: 0.2 } });

// After: options still work, and an adapter can take their place
new VernLLM({ client, model, retryBudget: redisRetryBudget(redis, { windowMs: 60_000 }) });
```

Existing code keeps compiling and behaves the same. Nothing changes unless you pass an adapter.
````

A good example:

- **Shows before and after** for anything changed or removed, and only the new usage for something added.
- **Is the smallest snippet that makes the point:** the call and the option, not a whole file.
- **Uses real names** from the package, so it can be copied.
- **Covers the failure side too** when an error code or type changes, by showing the `catch` a caller now needs.

Skip the code block only when nothing a caller writes changes, such as an internal fix.

Two mistakes to avoid:

| Instead of                          | Write                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| "Fix retry bug"                     | What a caller saw before, and what they see now                                    |
| "Purely additive" for a type change | That a new member on an exported union can break an exhaustive `switch`, if it can |

If the change needs migration steps, add an entry to [Migration Notes](https://vernllm.dev/docs/migration-notes) and link it from the changeset.

## What happens after you merge

1. Your pull request merges to `main` with its changeset.
2. A **Version Packages** pull request (`chore: version packages`) is opened or updated. It applies every pending changeset: versions are bumped and each package's `CHANGELOG.md` is written.
3. When a maintainer merges that pull request, each released package gets its own tag in `<package>@<version>` form and its own GitHub Release, with your changeset as the notes.
4. Each release is published to npm, and that package's changelog page on [vernllm.dev](https://vernllm.dev/docs/changelog) is regenerated.

Packages release independently, so one package's release never waits on another's. The docs site and the benchmark package are never versioned.
