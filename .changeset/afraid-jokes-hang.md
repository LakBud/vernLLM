---
'vern-llm': minor
---

Added an opt-in preflight check for Bedrock tool use support.

`fromBedrock` now accepts a second `options` argument with `toolUseSupportedModels`, either a static list of model IDs or a predicate function. When set, a `jsonSchema` call to a model not covered by it fails fast with `LLMError('validation')` before the request is sent.

Left unset, the default, no preflight check runs and a `jsonSchema` call to an unsupported model still surfaces Bedrock's raw error unchanged. `fromBedrock` does not try to reclassify or guess at that error from its text, since AWS's error message for an unsupported model is not a documented, stable contract.

Also refactored `VernLLM.ts` internally: inlined several small constructor only helper methods, tightened redundant logic, and expanded JSDoc coverage across the public API (constructor, `call`, `cachedCall`, `cachedLLMCall`, `deleteCache`, `getCircuitState`) with clearer parameter and return descriptions. No public behavior changed.

Docs updated in `adapters/bedrock.mdx` with a new "Preflighting tool use support" section.

Tests added covering the allowlist and predicate forms of `toolUseSupportedModels`, confirming `converse` is never called on a rejected preflight, and confirming non `jsonSchema` calls and the no option default skip the check entirely.
