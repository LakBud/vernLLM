## Summary

This PR adds a first-class `budgetTokens` option to `CallParams` alongside the existing `reasoningEffort` setting, and exposes a matching `reasoningTokens` field on `TokenUsage` when a provider reports separate reasoning usage.

The goal is to make reasoning budget controls consistent across providers while preserving current behavior for callers that do not set either field. Each adapter maps the option to the provider-specific native field, and the shared reasoning-budget conversion logic keeps provider differences in one place.

## Changes

- Added `budgetTokens?: number` to `CallParams` as a numeric reasoning budget option.
- Added `reasoningTokens?: number` to `TokenUsage` to capture provider-reported reasoning token usage when available.
- Updated provider adapters to read their native reasoning-budget field first:
  - Anthropic and Gemini use `budgetTokens` directly.
  - OpenAI-compatible adapters use `reasoningEffort` directly.
  - Bedrock forwards a budget only for Claude models, with fallback conversion via the shared reasoning budget utility.
- Centralized the reasoning budget conversion logic in `adapters/internal/reasoningBudget.utils.ts`.
- Documented the per-provider behavior in the Call Params reference.
- Kept the new fields optional so existing calls remain unchanged when nothing is set.

## Checklist

- [x] `pnpm run lint`
- [x] `pnpm run typecheck`
- [x] `pnpm run typecheck:test`
- [x] `pnpm run test` (or `pnpm run test:unit` / `pnpm run test:int` if scoping to one project)
- [x] Added or updated tests for the change
- [x] Added or updated docs for the change
- [x] Added a changeset (`pnpm run changeset`), if this affects `vern-llm` consumers

## Notes

The new fields are optional and do not change behavior for existing callers. `reasoningTokens` is provider-dependent: Bedrock does not currently populate it unless the request explicitly asks for that separate metric, which is outside the scope of this change.
