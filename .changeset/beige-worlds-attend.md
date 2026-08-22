---
'vern-llm': minor
---

A round of fixes and additions from a hands-on DX report exercising every built-in adapter
end-to-end. One real build-level bug, one error-message improvement, and one new capability
(with matching pre-flight validation) that came directly out of hitting these while wiring up a
real multi-provider example app.

**Fixed:** `fromBedrock`'s raw-AWS-SDK-client path threw `TypeError: ConverseCommand is not a constructor` (or the same for `ConverseStreamCommand`) on every call. The published build was
bundling `@aws-sdk/client-bedrock-runtime` into a local chunk instead of leaving the dynamic
`import('@aws-sdk/client-bedrock-runtime')` in `wrapAwsSendClient` as a genuine runtime import
resolved from the consumer's own `node_modules`. The bundler's CJS interop for that inlined chunk
only produced a `default` export, not real named exports, so destructuring
`ConverseCommand`/`ConverseStreamCommand` off the resolved module returned `undefined` for both.
`@aws-sdk/client-bedrock-runtime` (and every other provider SDK package, defensively, even though
none of the others are currently dynamically imported) is now marked `external` in the build
config, so it's never bundled. This also restores the documented zero-runtime-dependency
guarantee for this path: the AWS SDK was being silently embedded (~937KB) into every install
regardless of whether this path was ever used.

**Improved:** `LLMError.message` for provider API errors (`type: 'api'`) now includes the provider's own error description instead of always being the generic `"LLM request failed"`.
`describeError()` already existed internally and correctly extracted a provider's error body (it
was previously only used for `debug: true` logging); that detail is now folded into the thrown
error's own `.message` unconditionally. When a provider genuinely returns no error detail at all
(a non-2xx response with an empty body, which some providers do for certain field-validation
failures, e.g. sending `reasoning_effort` to a model that doesn't support it), the message now
says so explicitly and points at the likely cause, instead of falling back to the same
uninformative string every other API error got:

```text
LLM request failed with status 400 and no error detail from the provider. This usually means a
field or value in the request isn't supported by the specific model (for example, a
reasoning/thinking parameter the model doesn't accept), rather than a transport or auth problem.
```

`status`, `code`, `cause`, and every other field on `LLMError` are unchanged, this only affects
`.message` on `type: 'api'` errors. If you were matching on the exact previous message, match on
`.type === 'api'` and `.status` instead, both unaffected and always the more precise way to
branch on this.

**Added:** `budgetTokens`/`reasoningEffort` now accept `null` to explicitly skip an
instance-level `defaultBudgetTokens`/`defaultReasoningEffort` for one call, mirroring the
existing `temperature: number | null` pattern. Previously there was no way to say "not for this
call" once an instance default was set, only `undefined` (defer to the instance default) or a
real value (override it).

**Added:** Anthropic (and Claude models on Bedrock) now pre-validate `budgetTokens`/
`reasoningEffort` combined with a forced `toolChoice`. Anthropic rejects `thinking` (manual or
adaptive) alongside a `tool_choice` that forces tool use, a forced single tool or `'required'`,
with a 400: `"Thinking may not be enabled when tool_choice forces tool use."` This is now caught
locally and thrown as `LLMError('invalid_params')` before any request is sent, the same treatment
`budgetTokens >= maxTokens` already got. This also covers the implicit case where `jsonSchema`
silently forces a single synthetic tool call to emulate structured output on a model without
native support, even with no `toolChoice` of the caller's own set.

The last two land together because the second directly motivated the first: an instance-wide
`defaultBudgetTokens` used to make every forced-tool-choice call on that instance fail, with no
way to opt just that one call out short of dropping the instance default entirely.

```ts title="null-override-and-forced-tool-choice.ts"
const llm = new VernLLM({
  client: fromAnthropic(anthropic),
  model: 'claude-sonnet-4-6',
  defaultBudgetTokens: 1024, // reasoning on by default
});

// Throws LLMError('invalid_params') before any request is sent: forced
// toolChoice + budgetTokens (from the instance default) is a real
// Anthropic-side conflict.
await llm.call({
  userContent: 'summarize',
  tools: [summarizeTool],
  toolChoice: { name: 'summarize' },
});

// Fixed: explicitly opt this one call out of the instance-level reasoning
// default instead of dropping it for every call.
await llm.call({
  userContent: 'summarize',
  tools: [summarizeTool],
  toolChoice: { name: 'summarize' },
  budgetTokens: null,
});
```
