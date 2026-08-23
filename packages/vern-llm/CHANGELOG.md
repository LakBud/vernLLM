# vern-llm

## 2.4.2

### Patch Changes

- 25677cc: Anthropic and Bedrock now classify `tools` combined with `jsonSchema` on models outside
  `nativeStructuredOutputModels` as `LLMError('invalid_params')` with
  `code: 'unsupported_capability'` and `issues: { capability: 'tools_with_json_schema' }`. The
  existing `defaultFallbackOn` policy can therefore continue to the next target instead of stopping
  on the adapter's local capability restriction.
- f9dbdfe: Fixed two bugs in the Gemini adapter's tool call handling.

  Parallel calls to the same tool in one turn no longer throw a spurious `duplicate_tool_call_id` validation error. The adapter previously built every wire tool call id from the function name alone, so two calls to `get_weather` in the same turn always collided. Gemini 3 and later now populate a native, unique `id` on every `functionCall`, and the adapter uses it when present. On models before Gemini 3 that omit it, an id is synthesized from the function name plus how many times that name has already appeared in the response, so repeated calls to the same tool still get distinct ids.

  `functionResponse.name` sent back to Gemini is now resolved from the assistant turn's own prior tool call, instead of being assumed equal to the wire tool call id. The old assumption only held because ids were always synthesized from the name; it silently sent the wrong function name whenever a native id didn't match the name string.

  No change to `WireToolCall`, `ToolCall`, or any other adapter. Every fix stays inside `adapters/gemini.ts`.

- d8fa998: `buildStreamResult` now bounds its streamed `tool_call_delta` accumulator. `toolCallAcc` accepts at
  most 10,000 distinct tool-call indices, and each entry retains at most 1,000,000 argument
  characters. Both checks run before inserting a new map entry or appending to an existing argument
  string, so a misbehaving provider cannot grow either structure without limit.

  Exceeding either limit throws `LLMError('validation')` through the existing stream failure path.
  The iterator is cleaned up, the stream is aborted, and both `chunks` and `finalResult` observe the
  normalized failure instead of allowing the accumulator to continue consuming provider output.

- 64010df: `ToolCall.arguments` is now typed per tool instead of `unknown`, when TypeScript can see the exact tools passed to `call()`/`cachedCall()`.

  `ToolDefinition` is generic over the tool's `name` and its `argumentsSchema`'s inferred argument type. A new `defineTool()` helper preserves a tool's literal `name` (without requiring `as const`), which is what lets a `ToolCall` be matched back to the tool that produced it:

  ```ts
  import { z } from "zod";
  import { defineTool } from "vern-llm";

  const weatherTool = defineTool({
    name: "get_weather",
    description: "Gets the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    argumentsSchema: z.object({ city: z.string() }),
  });

  const result = await llm.call({
    userContent: "What is the weather?",
    tools: [weatherTool],
  });

  if (result.type === "tool_calls") {
    const call = result.toolCalls[0];
    call.arguments.city; // typed as string, no cast or re-parse needed
  }
  ```

  With more than one tool in the array, `arguments` is a discriminated union keyed by `name`; narrowing on `call.name` (`if (call.name === 'get_weather')` or a `switch`) is required before accessing a tool-specific field, the same way `isToolCallResult()` narrows `call()`'s own result union today.

  This only applies when TypeScript can see the exact tools at the `call()`/`cachedCall()` call site. A plain `const tools = [weatherTool, cancelOrder]` variable (assigned once, not conditionally, without its own type annotation) still narrows correctly when passed through, same as an inline array literal. Conditional tools (`tools: someCondition ? [weatherTool] : undefined`) also narrow correctly: `isToolCallResult()` is now generic and infers `Tools` from the result automatically in this case, no type argument needed. `arguments` falls back to `unknown` in three cases, all variations on TypeScript no longer having the literal tool objects to work with: the `tools` variable itself is explicitly annotated (`const tools: ToolDefinition[] = [...]`), the params object carries an explicit `: CallParams<T>` annotation, or `T` is pinned explicitly (`call<string>(...)`) alongside a literal `tools` array, TypeScript's own generic inference rules suppress inference for every subsequent type parameter once any leading one is explicit, not something specific to this library. Pass `Tools` explicitly to `isToolCallResult<typeof tools>()` (for the first two cases) or to `call<T, Tools>()`/`cachedCall<T, Tools>()` (for the third), or route through `defineCallParams()` instead of a `:` annotation, to recover typing in each case. Nothing about runtime behavior changes: validation, parsing, and error handling for tool arguments are unaffected.

- a14dd2a: Improve TypeScript inference for calls that combine `jsonMode: false` with conditional `tools`.
  `call()` and `cachedCall()`, with or without `stream: true`, now infer string content for the
  non-tool result without requiring an explicit response type, while preserving the wrapped content
  and tool-call result union when tools are present.

  The conditional string-tool parameter shapes are exposed as named helper types for reuse:
  `ConditionalStringToolCallParams`, `CachedConditionalStringToolCallParams`,
  `StreamConditionalStringToolCallParams`, and `CachedStreamConditionalStringToolCallParams`.

## 2.4.1

### Patch Changes

- dee6dbc: Fix the published bundle shipping unminified: `tsdown.config.ts` was missing `minify: true`, so the package shipped full source with comments instead of a minified build (~206 kB / ~59 kB gzipped instead of the intended ~72 kB / ~21 kB gzipped).

  While fixing this, also enabled `publint` and `unused` checks in the build and resolved what they found:

  - Fixed `exports["."].types` to resolve correctly under both `import` and `require` conditions (previously CJS consumers using `require()` with TypeScript could get the wrong types).
  - Added `"sideEffects": false` so bundlers can tree-shake the package.
  - Fixed `repository.url` to a full git URL.
  - Pinned `unplugin-unused` to `^0.4.4` to match the peer range `tsdown@0.9.9` actually requires.

  No public API changes.

## 2.4.0

### Minor Changes

- 411164c: A round of fixes and additions from a hands-on DX report exercising every built-in adapter
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
    model: "claude-sonnet-4-6",
    defaultBudgetTokens: 1024, // reasoning on by default
  });

  // Throws LLMError('invalid_params') before any request is sent: forced
  // toolChoice + budgetTokens (from the instance default) is a real
  // Anthropic-side conflict.
  await llm.call({
    userContent: "summarize",
    tools: [summarizeTool],
    toolChoice: { name: "summarize" },
  });

  // Fixed: explicitly opt this one call out of the instance-level reasoning
  // default instead of dropping it for every call.
  await llm.call({
    userContent: "summarize",
    tools: [summarizeTool],
    toolChoice: { name: "summarize" },
    budgetTokens: null,
  });
  ```

- c203fb2: `response_format: { type: 'json_object' }` is no longer emulated on `fromAnthropic`/`fromBedrock`
  via an unenforced system-prompt instruction ("Respond with valid JSON only, no prose or markdown
  fences."). Neither provider has a request field that mechanically guarantees JSON output for this
  mode. That instruction was a weaker guarantee than the type implied: the model could still ignore
  it, wrap output in prose, or add a markdown fence. This was also the one place in the codebase
  where an unsupported provider feature was silently degraded instead of failing loudly, unlike
  every other cross-provider gap (e.g. `jsonSchema` + `tools` on an unsupported model already throws
  instead of degrading).

  Both `LLMClient` implementations now report this via a new `supportsJsonObjectMode?: boolean`
  field (defaults to `true` when omitted; every OpenAI-compatible client and `fromGemini` are
  unaffected, since both map `json_object` to a real API field). `fromAnthropic` and `fromBedrock`
  set it to `false`, and `RequestBuilder`'s behavior branches on it:

  - **An explicit `jsonMode: true`** (or `VernLLM.call({ jsonSchema })` isn't set and you asked for
    JSON directly) on a client with `supportsJsonObjectMode: false` now throws
    `LLMError('invalid_params')` before the request is ever sent, naming the client and pointing at
    `jsonSchema` as the real alternative.
  - **The _default_, unset `jsonMode`, with no `schema` to validate against**, the common case of a
    plain `llm.call({ userContent })`, is silently downgraded to plain text instead of throwing.
    This keeps a bare `llm.call({ userContent })` working exactly as before on Anthropic/Bedrock, for
    callers who never actually wanted JSON and were just getting the library's default.
  - **`schema` without `jsonSchema`** always requires real JSON output to validate against, so it
    always throws `LLMError('invalid_params')` on `supportsJsonObjectMode: false` clients, naming
    the real cause, whether `jsonMode` was set explicitly or left at its default. An implicit request
    for JSON (via `schema`) is deliberately not silently downgraded the way a schema-less call is:
    doing so would skip validation entirely while reporting success.
  - **`jsonSchema`** is unaffected either way: it was never routed through `json_object`, and maps
    to a real API-level constraint on both providers (native structured output or a forced single
    tool call).

  If you were relying on `jsonMode: true` (explicitly or by default) to get JSON-shaped text on
  Anthropic/Bedrock without a `jsonSchema`, switch to `jsonSchema`. It's a strictly stronger
  guarantee anyway.

- 6d0bcdb: `fromBedrock` now accepts a raw AWS SDK v3 client directly. It takes either a hand-written
  `BedrockConverseClient` (`.converse()`/`.converseStream()`) or a real `BedrockRuntimeClient`
  (anything with `.send()`), and detects which one it got. No wrapper is required for the latter:

  ```ts
  import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
  import { VernLLM, fromBedrock } from "vern-llm";

  const client = new BedrockRuntimeClient({ region: "us-east-1" });

  const llm = new VernLLM({
    client: fromBedrock(client),
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  });
  ```

  `vern-llm` still has zero runtime dependencies. `@aws-sdk/client-bedrock-runtime` is not a
  dependency, not even a peer dependency. A raw AWS client pulls in
  `ConverseCommand`/`ConverseStreamCommand` with a dynamic `import()` on the first real request, not
  when `fromBedrock` is called. A missing install throws a clear `LLMError` naming what's missing.

  Also fixed two typing gaps between AWS's generated types and `BedrockConverseClient`, previously
  bridged with a plain `as` assertion:

  - AWS types `ConverseStreamCommandOutput.stream` as optional. `BedrockConverseClient`'s own
    `converseStream` always returns `{ stream: AsyncIterable<...> }`. A response missing `stream`
    now throws a clear `LLMError('api')` instead of crashing the internal `for await` loop.
  - AWS's real streaming event union includes a generated `$unknown` member VernLLM doesn't model.
    Every event is now narrowed through an explicit check first. Anything unmodeled, including
    `$unknown`, is dropped rather than forwarded.

  `fromBedrock(converseClient)` with a hand-written `BedrockConverseClient` is unaffected. It's
  still the zero-dependency option for a different AWS SDK generation or a hand-rolled HTTP client.

- 4756645: `call()` and `cachedCall()` return better types for JSON mode.

  Before, `jsonMode: false` still typed the result as `unknown`, even though the runtime value was always a `string`:

  ```ts
  const response = await llm.call({
    userContent: "Hello",
    jsonMode: false,
  });
  // response: unknown, but really a string
  ```

  Now the return type matches the requested mode:

  ```ts
  const response = await llm.call({
    userContent: "Hello",
    jsonMode: false,
  });
  // response: string

  const parsed = await llm.call({
    userContent: "Hello",
    jsonMode: true,
  });
  // parsed: JsonValue
  ```

  `JsonValue` is a new exported type for any valid JSON shape:

  ```ts
  type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };
  ```

  A call site that also sets `schema` still gets `T` inferred from the schema, exactly as before. This overload change only affects calls that don't use `schema`. Streaming calls (`stream: true`) get the same treatment: `finalResult` now resolves to `string`/`JsonValue` instead of `unknown` for the same two `jsonMode` cases, for both `call()` and `cachedCall()`.

  `ConversationTurn` assistant `content` now also accepts a parsed `JsonValue`, so a `jsonMode: true` result can be pushed straight into `history` without stringifying it yourself:

  ```ts
  import type { ConversationTurn } from "vern-llm";

  const history: ConversationTurn[] = [];

  const parsed = await llm.call({
    userContent: "Give me a JSON summary.",
    jsonMode: true,
  });

  history.push(
    { role: "user", content: "Give me a JSON summary." },
    { role: "assistant", content: parsed }
  );
  ```

  VernLLM's request construction `JSON.stringify`s non-string assistant `content` before it's sent as part of the wire request, so no manual stringifying is needed on the caller's side.

- b3a5de4: Added `budgetTokens` on `CallParams`, a numeric reasoning budget alongside the existing
  `reasoningEffort` tier string.

  Each adapter reads its own native field first. Anthropic and Gemini use `budgetTokens` directly.
  OpenAI compatible clients use `reasoningEffort` directly. Bedrock forwards a budget only for Claude
  models. When only the other field is set, it is converted through a shared table, documented in
  `adapters/internal/reasoningBudget.utils.ts`.

  Also added `reasoningTokens` on `TokenUsage`, a subset of `completionTokens`, populated whenever
  the provider reports a separate figure for internal reasoning. Undefined for Bedrock today, since
  Converse only returns that figure if the request explicitly asks for it, a separate feature outside
  this change.

  Added `defaultReasoningEffort` and `defaultBudgetTokens` on `VernLLMOptions` and `FallbackTarget`,
  matching the existing `defaultTemperature` pattern. Resolution order is per call value, then the
  fallback target's own default, then the instance default.

  Added `reasoningEffortTokens` as an option on `fromAnthropic`, `fromGemini`,
  `fromOpenAICompatible`, and `fromBedrock`, letting the conversion table itself be overridden per
  adapter instance. Only the tiers listed are changed, any tier left out keeps the built in default.

  Neither field is required. Existing calls and instances that set nothing here are unaffected.

  See the `budgetTokens` row in the
  [Call Params reference](https://vernllm.vercel.app/docs/API-reference/call-params) for full per
  provider behavior.

- d420f6f: `fromGemini` now accepts the whole `@google/genai` client, not just `ai.models`, and unwraps
  `.models` internally:

  ```ts
  import { GoogleGenAI } from "@google/genai";
  import { VernLLM, fromGemini } from "vern-llm";

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const llm = new VernLLM({
    client: fromGemini(ai),
    model: "gemini-2.5-flash",
  });
  ```

  `fromGemini(ai.models)` still works exactly as before. `GeminiClient` now models both shapes
  itself, via an optional self-referencing `models?: GeminiClient` field, so there's nothing new to
  import: passing `ai` directly, or `ai.models`, both type-check against the real `GoogleGenAI`
  client with no `as GeminiClient`/`as unknown as` cast required anywhere. Previously, `GeminiClient`
  diverged from the real SDK's generated types on `model` (optional here vs. required there),
  `functionCall.args`/`functionResponse.response` (`unknown` here vs. `Record<string, unknown>`
  there), and `toolConfig.functionCallingConfig.mode` (a plain string union here vs. a real string
  enum there, which TypeScript never treats as structurally compatible); all three are now aligned.

  **Behavior change:** `parseToolResult` (used for `role: 'tool'` messages) now always produces an
  object for Gemini's `functionResponse.response`, matching the real SDK's
  `Record<string, unknown>` requirement there. A tool result whose `content` parses to something
  other than a plain JSON object, a bare string, number, array, or unparseable text, is now wrapped
  under an `output` key (e.g. `content: '"sunny"'` sends `{ output: 'sunny' }` instead of the bare
  string `'sunny'`). Tool results that are already JSON objects are unaffected.

  `fromGemini` now throws `LLMError('invalid_params')` immediately if the client it's given, and its
  `.models` if present, has no `generateContent` (or `generateContentStream`, for `stream: true`
  calls) that's actually a function, instead of deferring to a confusing native `TypeError` on the
  first real call.

- adca7fb: Every recorded `RetryAttempt` now also carries `request`, a snapshot of what was actually sent for
  that attempt, sitting next to the existing `error` snapshot of what came back:

  ```ts
  try {
    await llm.call({ userContent: "Hello" });
  } catch (err) {
    if (isLLMError(err)) {
      for (const attempt of err.attempts ?? []) {
        console.log(attempt.error.message, attempt.request?.body);
      }
    }
  }
  ```

  `request` is an `LLMRequestSnapshot`:

  ```ts
  interface LLMRequestSnapshot {
    provider: string;
    model: string;
    body: unknown;
    headers?: Record<string, string>;
    startedAt: number;
  }
  ```

  Auth headers (`Authorization`, `x-api-key`, `x-goog-api-key`, `api-key`) are always stripped
  before the snapshot is built, case insensitively, so they never end up in `headers`.

  `request` is optional and additive. It is `undefined` on attempts recorded before this field
  existed, and `FallbackAttempt` picks it up for free since it already extends `RetryAttempt`. No
  existing field, method, or constructor option changes shape.

### Patch Changes

- 40212b7: `call()`/`cachedCall()` (including their `stream: true` variants) no longer silently mistype a
  `tool_calls` result as plain content when `tools` is set conditionally:

  ```ts
  const tools = condition ? [myTool] : undefined;

  const result = await llm.call({ userContent, tools });
  // Before: typed `unknown` (or whatever T you asked for), even though the
  // runtime value could genuinely be a `tool_calls` result once `tools` was
  // actually an array at call time.
  // Now:    typed `T | CallWithToolsResult<T>`, so `isToolCallResult(result)`
  // is required (and correctly enforced) before treating it as plain content.
  ```

  The runtime behavior was already correct: `call()` has always returned a real
  `CallWithToolsResult<T>` whenever the model was actually offered tools, regardless of whether
  `tools` was a literal array or a variable. Only the _type_ was wrong, `tools: ToolDefinition[] |
undefined` matched neither the tools-enabled nor the tools-disabled overload, so TypeScript fell
  through to the final generic overload and typed the result as plain `T`.

  This adds a `ConditionalToolCallParams<T>` overload (and cached/streaming counterparts
  `CachedConditionalToolCallParams<T>`, `CachedStreamConditionalToolCallParams<T>`) that catches this
  shape and returns the honest union instead. It's picked up automatically; no code changes are
  needed to benefit from it, as long as `tools`'s narrower type reaches `call()` intact (an inline
  literal, or a variable that hasn't been widened by an explicit `: CallParams<T>` annotation, see
  below). Call sites using a literal `tools: [...]` array are unaffected and keep inferring
  `CallWithToolsResult<T>` directly, same as before. Call sites that omit `tools` entirely are also
  unaffected, since tools genuinely cannot have run there.

  **New exports: `defineCallParams()` / `defineCachedCallParams()`.** A `: CallParams<T>` variable
  annotation widens `tools` away before it ever reaches `call()`, no overload fix can recover from
  that (it's how TypeScript's type annotations work, not a gap in this library). These two are
  identity functions, return exactly what you pass them, for building a `call()`/`cachedCall()`
  params object in a named, reusable variable without hitting that trap:

  ```ts
  import { defineCallParams } from "vern-llm";

  const params = defineCallParams({
    userContent: "What is the weather?",
    tools: someCondition ? [weatherTool] : undefined,
  });

  const result = await llm.call<string>(params);
  // result: string | CallWithToolsResult<string> (defaults to unknown if T
  // isn't pinned via call<T>() or schema)
  ```

  They work by giving `P` (the whole params object) a single, plain generic parameter, no `const`
  type parameter needed. TypeScript 5.0's `const` type parameters would also solve this, but they'd
  silently raise this package's effective minimum TypeScript version (this package declares none
  today, and the whole package's `.d.ts` would fail to parse on TypeScript `<5.0`, not just these two
  functions), and turned out to be unnecessary here anyway: `tools: someCondition ? [tool] :
undefined`'s type is already the union the ternary computes, not a literal that needs `const` to
  avoid being widened. `T` isn't a parameter of `defineCallParams()` itself; pin it the normal way,
  via `llm.call<T>(params)`, exactly as you would with an inline object. `satisfies CallParams<T>`
  remains a valid, import-free alternative to `defineCallParams()` for the same purpose.

  `isToolCallResult()` was already the documented way to narrow a dynamically-typed result; this
  change makes TypeScript require that check for the conditional-tools case instead of only
  recommending it in a doc comment.

## 2.3.0

### Minor Changes

- a441b47: `LLMError` now defines `toJSON()`, controlling what `JSON.stringify(err)` produces:
  `name`, `message`, `type`, `status`, `issues`, `retryAfterMs`, `code`, `retryable`, `attempts`.
  `LLMErrorSnapshot` (the shape of `RetryAttempt.error`, also what `toSnapshot()` returns) carries
  the same fields except `name`: `message`, `type`, `status`, `issues`, `retryAfterMs`, `code`,
  `retryable`, `attempts`.

  `cause` is left out of both, deliberately. `cause` is `unknown` and never validated by VernLLM, so
  it is the one field on `LLMError` that is not guaranteed safe to hand to `JSON.stringify`: some
  SDKs throw errors with circular internal references, which `JSON.stringify` cannot serialize.
  `err.cause` on the live, just-caught error is unaffected and still holds the exact original value.
  That is where `cause` is meant to be read, on the spot, not folded into serialization or carried
  inside retry history.

  `message` and `retryable` are included even though a plain property walk would miss both:
  `message` is non-enumerable on `Error`, and `retryable` is a getter, not an own property.

  `issues` is included, but not unconditionally. For a schema validation failure, `issues` is a
  caller supplied `SchemaLike` validator's own `error: unknown`, not controlled by VernLLM and not
  guaranteed circular free. A circular `issues` value is replaced with an explicit marker string in
  the serialized output, rather than dropped silently or left to throw. `err.issues` on the live
  error is unaffected. This check runs recursively through every nested `attempts` entry's own
  `issues` too, not just the top level `issues`, since `attempts` is itself a public constructor
  option a caller can hand build, and a previously safe `issues` reference on a snapshot can be
  mutated into a circular one later.

- 7af6ecd: Reworked the `LLMError` taxonomy so `type` stays a small, closed set a caller can exhaustively `switch` over, while `code` carries the specific reason underneath it. This is a breaking change to several already-shipped `type`/`code` values, accepted on minor since `vern-llm` is still in beta:

  - Tool contract failures (`unknown_tool`, `duplicate_tool_call_id`, `tool_choice_none_violated`, and the previously uncoded "provider returned `tool_calls` with no `tools` sent" case, now `code: 'unexpected_tool_calls'`) move from `type: 'api'` to `type: 'validation'`. They're a provider contract violation, not an HTTP failure.
  - A new `type: 'invalid_params'` splits off from `type: 'validation'` for every check that's deterministic on the caller's own input and never touches the network: the `requestBuilder.ts` checks (empty/duplicate tools, `toolChoice` issues, schema/`jsonMode` conflicts, history ordering), the `cachedCall` `reserveUsage`/`refundUsage` guard, `imageFormat.ts`'s mimeType check, and "no provider targets configured." A new `code: 'unsupported_capability'` covers the one pattern repeated across adapters: `stream: true` against a client with no streaming method, a model outside `toolUseSupportedModels`, or `toolChoice: 'none'` against a provider with no equivalent.
  - Local rate-limit rejections move from `type: 'quota_exceeded'`, `code: 'local_rate_limit'` to `type: 'rate_limited'`, split into three specific codes: `rate_limit_queue_full`, `rate_limit_queue_timeout`, and `rate_limit_capacity_exceeded`. The old single code couldn't tell a caller whether waiting and retrying later was worth attempting; `rate_limit_capacity_exceeded` never will, the other two usually will once load drops. `type: 'quota_exceeded'` now means only what it originally described: a `reserveUsage` hook rejecting the call.
  - `code: 'invalid_credentials'` is replaced by `authentication` (401) and `authorization` (403), so a caller can tell a missing key apart from a key that lacks access without VernLLM inventing a new `type` for every HTTP status. New codes `not_found` (404), `payload_too_large` (413), `server_error` (5xx), and `empty_response` round out the HTTP-status-derived set.
  - A new `type: 'network'` with `code: 'connection_failed'` separates transport-level failures (DNS, connection refused, connection reset) from the catch-all `type: 'unknown'`.
  - `FallbackExhaustedError.type` is now always `'fallback_exhausted'`, its own identity, instead of inheriting the last attempted target's `type`. `status` and `retryAfterMs` still inherit from the last attempt.

  Added `LLMError.retryable`, computed purely from `type`/`code`, independent of any specific call's `nonRetryableStatus` list or its signal's abort state. `FallbackExhaustedError` overrides it to defer to the last attempted target's own `retryable`, since `type: 'fallback_exhausted'` alone carries no retry signal.

  `LLMError`'s constructor collapses everything after `type` into one optional object: `new LLMError(message, type, { status, code, issues, cause, retryAfterMs })`. Previously these were five more positional parameters, so a throw site that only needed `code` still had to write four `undefined`s to reach it. This breaks any `new LLMError(...)` call site outside the package itself, including a custom `LLMClient` adapter or a subclass calling `super()` positionally — narrower than it sounds, since callers normally only catch `LLMError`, not construct it, but worth naming directly: the last time this constructor grew, the explicit goal was that every existing call site would keep compiling unchanged, and this change knowingly reverses that.

  Removed the deprecated `toolIssues` getter/setter on `LLMError`. `issues` is now the only place tool contract problems (or a schema validator's error object) are carried; read `error.issues` instead of `error.toolIssues`.

  `LLMError.retryable` now also returns `false` for `type: 'aborted'`, matching the taxonomy's own type table (previously an aborted error would report `retryable: true`, which contradicted intentional-cancellation semantics). `CallExecutor`'s internal retry/circuit-breaker accounting is unaffected, since an aborted signal was already checked separately before either ever consulted `retryable`.

  `issues` gained real types instead of being blanket `unknown`. `LLMErrorIssuesByCode` maps every code that carries structured data to its exact shape, and a new `hasIssues(err, code)` type guard narrows `err.issues` off that same `code` with no manual cast:

  ```ts
  if (isLLMError(err) && hasIssues(err, "duplicate_tool_names")) {
    console.log(err.issues.names); // string[], fully typed
  }
  ```

  Five new codes back this: `duplicate_tool_names` and `unknown_tool_choice` (both `requestBuilder.ts` checks that previously threw uncoded), and `duplicate_tool_result_ids`/`unknown_tool_result_ids`/`missing_tool_results` (the three `history` "tool" turn checks, also previously uncoded). All five, plus the existing `unsupported_capability`, now carry a typed `issues` payload built from the same list the `message` already string-joins, rather than making a caller re-parse it out of prose. `unknown_tool`/`duplicate_tool_call_id` (`ToolIssue[]`) are unchanged, just added to the same lookup table. Every other `invalid_params` check stays uncoded and without `issues`, since it's a single deterministic fact the `message` already states in full. Schema-validation failures (`type: 'validation'`, no `code`) are the one deliberate exception left as `unknown`: that payload is the caller's own Zod-compatible validator's error object, a shape VernLLM can't know in advance.

- 532ebf4: LLMError now carries an optional attempts array, one entry per attempt made against the current target before the error was thrown, each with that attempt's index and a snapshot of that attempt's error. Absent when nothing was retried.

  Added RetryAttempt, the shape of each entry, and LLMErrorSnapshot, the shape of `RetryAttempt.error`: an inert, point-in-time copy of an LLMError's fields (message, type, code, status, issues, retryAfterMs, cause, retryable), produced by the new `LLMError.toSnapshot()`. A recorded attempt is a record, not a live, throwable error, so `RetryAttempt.error` is a snapshot rather than an `LLMError` itself; this also keeps `RetryAttempt` from being self-referential through `LLMError.attempts`. FallbackAttempt now extends RetryAttempt instead of declaring its own index and error fields, so FallbackExhaustedError.attempts keeps its existing shape unchanged, provider and model alongside the inherited index and error.

  Added isFallbackExhaustedError, a guard function for narrowing a caught error to FallbackExhaustedError without a manual instanceof check.

- 53ec728: Added manual circuit-breaker control: `VernLLM.openCircuit(target?)` and `VernLLM.closeCircuit(target?)` let a caller force a target's breaker open or closed (e.g. to pull a provider out of rotation ahead of known maintenance, or to skip the cooldown once a provider is confirmed healthy again), without waiting for real traffic to trip it. Both take an optional `{ index?, model? }`, defaulting to the primary target's shared circuit.

  `getCircuitState` now takes the same `{ index?, model? }` shape instead of a bare `model` string, so it can address fallback targets too, not just the primary. This is a breaking change to an already-shipped signature: `llm.getCircuitState('gpt-4o')` becomes `llm.getCircuitState({ model: 'gpt-4o' })`. Being accepted on minor since `vern-llm` is still in beta and `getCircuitState` was itself a fairly recent addition.

  An out-of-range `index` on `getCircuitState`/`openCircuit`/`closeCircuit` now throws `RangeError`, so it stays distinguishable from a real target that simply has no breaker configured (which still returns/no-ops normally). Passing `model` to a target whose breaker doesn't have `circuitBreaker.isolateByModel` on now logs a warning instead of silently doing nothing, since the shared-bucket state or action is used regardless.

  When `model` is omitted on `getCircuitState`/`openCircuit`/`closeCircuit`/`getCircuitStates`, it now defaults to that target's own configured model instead of the unlabeled bucket, matching the bucket real call failures/successes are recorded under for a target with `isolateByModel` on. An explicit `model` argument is unaffected.

  `getCircuitStates()` entries now include `isolateByModel`, so a caller sweeping `model` across a fallback chain with mixed per-target configs can tell which entries actually honored it.

### Patch Changes

- af02955: The internal logger is now wrapped so a throwing custom logger can no longer break the call it was logging about. If a user-supplied logger.debug, logger.warn, or logger.error throws, the error is caught and dropped, and the original operation still completes normally.
- b56c35b: Cache adapter failures now go through logger.warn instead of being invisible. A get failure is treated as a miss and falls through to a real provider call. A set failure happens after the result is already computed and is still swallowed, just now logged. A delete failure used to propagate as a thrown error; it is now caught and logged instead.

## 2.2.0

### Minor Changes

- d1f7d17: Added a `call()` overload for `toolChoice: 'none'`, narrowing the return type to `ContentResult<T>`
  instead of the full `CallWithToolsResult<T>` union, since the model is structurally barred from
  returning a `tool_calls` result in that case. This can change the inferred return type at existing
  call sites that already pass `tools` with `toolChoice: 'none'`: code that defensively checked
  `isToolCallResult(result)` or accessed `result.toolCalls` there will now see a type error, since
  `toolCalls` isn't a field on `ContentResult<T>`.

  The `ContentResult<T>` guarantee is now also enforced at runtime: if a provider (or a custom
  adapter) returns `tool_calls` anyway despite `toolChoice: 'none'`, `call()` throws
  `LLMError('api')` instead of silently returning a `{ type: 'tool_calls', ... }` result that would
  contradict the narrowed type.

  Also tightened `cachedCall`: `reserveUsage`/`refundUsage` no longer type-check inside the nested
  `call` object on `CachedCallParams`/`CachedToolCallParams`/`CachedStreamCallParams`/
  `CachedStreamToolCallParams`, they belong at the top level alongside `cacheKey`/`ttl`. A caller that
  bypasses the type system and sets them inside `call` anyway now gets `LLMError('validation')`
  instead of a runtime warning and silent no-op.

### Patch Changes

- ad44612: Removed GitHub model and klusterAI from openAI compatible aliases and tests since they are deprecated.
- 49b7fbf: Fixed two bugs found during a code review pass:

  `FallbackExhaustedError` now inherits `retryAfterMs` from the last failed target's error, matching
  the `type`/`status`/`cause` it already inherited. Previously `retryAfterMs` was hardcoded to
  `undefined`, so a caller following the documented pattern of reading `err.retryAfterMs` on an
  `'api'`-typed error would silently lose the provider's actual Retry-After value in the one case
  where every target, including the last, failed with a rate limit.

  `RateLimiter`'s internal `TokenBucket` no longer loses already-refilled capacity when the system
  clock moves backward (NTP correction, VM migration, etc.). A negative elapsed time between refills
  was previously multiplied straight into the bucket's `available` count, silently discarding real
  capacity and rate-limiting harder than configured until the bucket caught back up. Elapsed time
  below zero is now treated as no time having passed, rather than negative time.

  Also removed a dead-code `maxQueueSize` check in `RateLimiter.acquire`'s fast path (the queue is
  always empty there, so the check could never fire); no behavior change.

## 2.1.1

### Patch Changes

- 09c330b: Added `fromOpenAI`, an alias of `fromOpenAICompatible` for OpenAI clients. The
  existing `fromOpenAICompatible` adapter supports providers such as Groq and Mistral.

  Passing a raw `new OpenAI(...)` instance directly as `client` structurally satisfies `LLMClient`
  for basic non-streaming, text-only calls, but silently misses two things that only live in the
  adapter layer: `ContentBlock[]` multimodal translation to OpenAI's `image_url` format, and
  `createStream` wiring for `stream: true` (the raw SDK has no `createStream` method). Newer `openai`
  SDK majors (v7+) also widened `ChatCompletionContentPart` in ways that can make an unwrapped client
  fail to typecheck against `LLMClient` altogether, independent of any VernLLM version, since `openai`
  is not a peer dependency here.

  `fromOpenAI(client)` is a plain alias for `fromOpenAICompatible(client)`, no behavior change beyond
  the name. Existing code passing a raw client is unaffected; `fromOpenAI` is the recommended path
  going forward. See [Migration Notes](https://vernllm.vercel.app/docs/migration-notes) for details.

## 2.1.0

### Minor Changes

- 8014818: Added observability events, provider labeling, and fixed a tool-contract retry defect.

  `VernLLMOptions.onEvent` reports `'retry'` and `'circuit_state'` events as they happen. Fire-and-forget, mirroring the existing `onUsage` pattern exactly: a throwing handler is caught and logged, its return value is never read, and it can only ever change what gets reported, never what the call does.

  `VernLLMOptions.name` (default `'primary'`) labels a `VernLLM` instance. It's threaded into `TokenUsage.provider` and every emitted event, so a shared `onEvent`/`onUsage` handler can tell multiple instances apart. This also lays the groundwork for multi-target fallback in a future release.

  `CircuitBreaker` was refactored so every state mutation routes through a single `transition()` method, guaranteeing `onStateChange` (and now `onEvent`'s `'circuit_state'`) fires exactly once per real transition, never on a no-op like open to open. `assertClosed`/`recordSuccess`/`recordFailure` now accept an optional `model` param, reported on the transition it triggers; the breaker's failure counting is unchanged, still shared-fate across models by default, so this only affects what's reported, not when the circuit opens or closes.

  Both the `'retry'`/`'circuit_state'` events and the breaker's `assertClosed` gate now use the model actually resolved for that call (honoring a per-call `model` override) instead of always the instance default.

  Fixed `validateToolCallArguments`: an unknown tool name or a duplicate tool-call id was previously classified `type: 'api'` with no distinguishing code, which meant `shouldRetry` treated it as retryable, burning the whole retry budget on a request that was guaranteed to fail identically every time (the wire request doesn't change between attempts). These failures now carry `code: 'unknown_tool'` or `code: 'duplicate_tool_call_id'` (still `type: 'api'`, so no existing type check breaks) and are excluded from retry. Every such issue in a response is now aggregated into one error's `toolIssues: ToolIssue[]`, instead of throwing on the first and hiding the rest. Schema-validation failures are unchanged: still a separate pass, still `type: 'validation'`, still first-failure-only.

  `LLMError` gains two new optional, additive fields: `code: LLMErrorCode` and `toolIssues?: ToolIssue[]`. Both are appended as the last positional constructor params, so every existing `new LLMError(...)` call site keeps compiling unchanged.

- 11c83db: Added `VernLLMOptions.redact`, applied to model output before it reaches the debug logger.

  `debug: true` logs up to 800 characters of raw model output on success, and the provider's original error on failure, including a stream-open failure. Until now there was no way to scrub that output before it hit the logger, an accidental spot for prompt content or PII to end up in logs. `redact` closes that gap:

  ```ts
  const llm = new VernLLM({
    client: openai,
    model: "gpt-4o",
    debug: true,
    redact: (text) => text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED]"),
  });
  ```

  Applied to every internal debug log line, the success output, a failed `call()`, and a failed stream open, the one place an app has no other way to intercept, since these are direct `logger.debug` calls rather than something routed through a callback. `onEvent` payloads, `LLMError.cause`, and `onUsageFailure` already hand raw content straight to app-owned callbacks, so redacting those needs no help from `VernLLM`; only the debug log required a new option.

  `redact` runs before every internal `logger.debug()` call regardless of whether that call ends up emitting anything. With the default console logger, `debug: false` (the default) means nothing is logged, so `redact` has no visible effect. With a custom `logger`, `VernLLM` doesn't check `debug` at all before calling into it, that logger's own `debug()` decides whether to emit, so `redact` runs and can have a visible effect even without `debug: true`.

  Additive and optional. Omitting `redact` is a no-op, identical to today's behavior.

- 8014818: Added client-side rate limiting.

  `VernLLMOptions.rateLimit` queues calls locally to stay under configured `requestsPerMinute`, `tokensPerMinute`, and/or `maxConcurrent` caps, instead of dispatching and letting the provider reject with a 429. This is proactive, unlike the existing `Retry-After` handling in the retry loop, which only reacts after a self-inflicted rate limit has already cost a round trip. Omit `rateLimit` for unlimited, exactly matching pre-existing behavior.

  ```ts
  new VernLLM({
    client,
    model: "gpt-4o",
    rateLimit: { requestsPerMinute: 500, maxConcurrent: 20 },
  });
  ```

  Capacity is acquired per retry attempt, not once per call, since every retry is a real request against the same limits. For `stream: true`, capacity is held for the connection's full lifetime and released only once the stream completes (success or a mid-stream failure), not when it merely opens, since a stream holds a real connection the whole time it's open.

  `tokensPerMinute` is enforced against a pre-flight estimate (a chars/4 heuristic over message content plus `max_tokens` by default, overridable via `estimateTokens`), then reconciled against real reported usage once the call completes, so a systematically over- or under-estimating heuristic self-corrects rather than compounding.

  A call that can't get capacity within `maxQueueMs` (default 30000, pass `0` to wait indefinitely) or finds the queue already at `maxQueueSize` (default `0`, unbounded) throws `LLMError` with `type: 'quota_exceeded'` and the new `code: 'local_rate_limit'`, reusing the existing type since a locally-stopped call before anything was sent is exactly what `quota_exceeded` already means. `shouldRetry` now excludes this code: the wait already happened, so retrying immediately would only requeue behind the same limit with nothing changed.

  Provider 429s are unaffected in shape, still `type: 'api'`, `status: 429`, but now also carry the new `code: 'provider_rate_limited'` for callers that want to distinguish a real provider rate limit from a local one without checking `status` directly.

  Queued waiters are served strictly FIFO, so a large call can't be starved indefinitely by a stream of smaller ones queued behind it, and a waiter whose `signal` aborts while queued is removed and rejects with `type: 'aborted'` immediately rather than continuing to hold a queue slot.

  `onEvent` gains a `'rate_limited'` event, reported whenever an attempt actually had to wait for capacity, carrying `waitedMs` and which bucket (`'concurrency' | 'rpm' | 'tpm'`) was blocking it.

  New exports: `RateLimiter`, `RateLimitOptions`, `RateLimitReason`, `RateLimitAcquireResult`, `WireRequest`, and `defaultEstimateTokens`.

  `LLMErrorCode` gains `'local_rate_limit'` and `'provider_rate_limited'`, and `VernLLMEvent` gains the `'rate_limited'` kind, both additive to fields that were also newly introduced in this same release cycle, so nothing published to date is affected. Note for anyone consuming this as a standalone follow-on to an already-released `onEvent`/`code`: TypeScript still treats adding a member to a previously-public union as a compile-time break for consumers who exhaustively `switch` over `LLMErrorCode` or `VernLLMEvent['kind']` with a `default: never` guard (the same tradeoff already accepted for `code` itself and for `VernLLMEvent`, deliberately not extended to `LLMErrorType`, which stays closed for this reason).

- 62541be: Added cross-provider fallback, declared inline on the constructor.

  `VernLLMOptions.fallback` takes an ordered `FallbackTarget | FallbackTarget[]`, each with its own `client`/`model` and, optionally, its own `maxRetries`, `timeoutMs`, `chunkIdleTimeoutMs`, `baseDelayMs`, `defaultMaxTokens`, `defaultTemperature`, `nonRetryableStatus`, `circuitBreaker`, and `rateLimit` (per-target overrides fall back to the parent instance's own option when omitted; `circuitBreaker`/`rateLimit` are never inherited, each target's is independent of every other target's). Order is the policy: `VernLLM` never reorders, scores, or health-checks targets, it only walks the list as given, after the primary and after each earlier fallback target is exhausted or abandoned.

  ```ts
  const llm = new VernLLM({
    client: openai,
    model: "gpt-4o",
    fallback: [
      { client: anthropic, model: "claude-sonnet-5", name: "anthropic" },
      { client: gemini, model: "gemini-2.5-flash", name: "gemini" },
    ],
  });
  ```

  `VernLLMOptions.fallbackOn` decides what happens once a target's own retries are exhausted or abandoned early: `'next'` moves on to the following target, `'stop'` gives up immediately. `'retry'` isn't a valid return here, retrying already happened inside the target. Defaults to the new exported `defaultFallbackOn`, which stops on `parse`/`validation`/`aborted`/`quota_exceeded` errors and on tool-contract failures (`code: 'unknown_tool'`/`'duplicate_tool_call_id'`, the model ignoring the request rather than the provider being unhealthy) since none of those are fixed by trying a different provider, and moves on for everything else, including a rate-limited or open-circuit target. Exported so a caller can wrap rather than replace it.

  Every target keeps its own retry state, circuit breaker, and rate limiter, so tripping one target's breaker never affects another's. A `circuitBreaker`-open primary now falls over to the next target instead of hard-failing the call, since an open breaker is just another target failure as far as `fallbackOn` is concerned.

  `CallParams.meta`, an optional `{ current?: CallMeta }` out-parameter, is written with `{ provider, model, fallbackIndex, usedFallback, attempts }` once `call()` resolves, so a caller who wants provider identity on the same line as the result doesn't need to read it back out of `onUsage`. Ignored for `stream: true`, since `call()` returns before the outcome (and so the target that answered) is known; `TokenUsage.provider`/`usedFallback` from `onUsage` cover that case instead. `TokenUsage` gains `usedFallback?: boolean` alongside the existing `provider?: string`.

  `onEvent` gains a `'fallback'` event, reported when the chain moves to the next target, carrying `from`/`to` provider names, `fromIndex`/`toIndex` (`-1` for the primary), the normalized error that caused the move, and `elapsedMs` spent on the abandoned target.

  When every target fails, `call()` throws the new `FallbackExhaustedError` (extends `LLMError`, so `isLLMError`/`instanceof LLMError` still passes, inheriting the last failure's `type`), carrying `attempts: FallbackAttempt[]`, every target's own normalized error in order, so a cross-provider outage stays debuggable without reproducing it. A lone target (no `fallback` configured) throws exactly what it throws today, unchanged: the single-iteration path is identical to pre-fallback behavior.

  Fallback applies to stream-open failures only. Once a chunk has been emitted, `VernLLM` does not fall over mid-stream, since splicing a second model's output into a response the consumer has already partially rendered would corrupt it; a stream-open failure (before the first chunk) falls over exactly like a non-streaming failure does.

  `cachedCall` composes with fallback automatically, since fallback lives inside `call()`: the whole chain caches under one key and the successful result, however far down the chain it came from, is what gets stored, with in-flight coalescing covering the full chain too.

  As a small additive circuit-breaker improvement, `VernLLM.getCircuitStates(model?)` now exposes the current circuit state for the primary and all fallback targets in declaration order. The existing `VernLLM.getCircuitState(model?)` continues to expose the primary circuit state. `circuitBreaker.onStateChange` and the `circuit_state` `onEvent` event can be used to observe transitions, including those belonging to fallback targets.

  `LLMErrorCode` gains `'fallback_exhausted'`, additive.

  New exports: `FallbackTarget`, `FallbackOn`, `FallbackAttempt`, `CallMeta`, `FallbackExhaustedError`, `defaultFallbackOn`.

  Tests added covering: primary success leaving every fallback target untouched, falling over on primary exhaustion with a byte-identical wire request (including `tools`) reaching the next target, `parse`/`validation`/`quota_exceeded`/tool-contract errors stopping the chain instead of falling over, a rate-limited or circuit-open target falling over, per-target breaker independence, `FallbackExhaustedError.attempts` carrying every failure in order, the no-fallback-configured case throwing identically to pre-fallback behavior, the stream-open-only limitation, `cachedCall` storing the fallback-produced result, `TokenUsage` identity matching whichever target answered, the default and a custom `fallbackOn` policy, the `'fallback'` event, and the additive circuit state API. Also added real-SDK integration tests driving actual `openai`, `@anthropic-ai/sdk`, `@google/genai`, and `@aws-sdk/client-bedrock-runtime` clients, each as a distinct fallback target against its own local mock server, exercising a full four-provider fallback chain, a real streaming open-failure fallover, and `FallbackExhaustedError` collecting every real provider's parsed error.

- 6924a7f: Added opt-in support for combining `tools` with `jsonSchema` on Anthropic and Bedrock, on models that support native, schema-constrained output.

  Previously, `VernLLM` unconditionally rejected `tools` combined with `jsonSchema` or `schema` at the orchestration layer for every provider. The underlying provider-level collision that motivated that generic guard was specific to Anthropic/Bedrock, where `jsonSchema` was implemented internally as a forced single tool call sharing the same `tools`/`toolConfig` field as caller-supplied tools. Both providers have since added a schema-constrained output mechanism that lives in its own request field, independent of tool calling, Anthropic's `output_config.format` and Bedrock Converse's `outputConfig.textFormat`, so the combination is no longer categorically invalid there, only invalid on models that lack that mechanism. The removed guard therefore covered both `jsonSchema` and `schema`; `schema` itself remains client-side validation, but it was included in the old blanket mutual-exclusion check.

  `fromAnthropic` and `fromBedrock` now accept `nativeStructuredOutputModels` as part of their second `options` argument, either a static list of model IDs or a predicate function. On a covered model, `jsonSchema` composes with real `tools` in the same request. There is no built-in default list: which models support this is each provider's call to make, not this package's, and it changes over time, so hardcoding a guess would risk silently routing a request onto a field a given model doesn't actually support, trading a clear validation error for a confusing one from the provider. Left unset (the default), every model keeps using the forced-single-tool-call emulation, and `tools` + `jsonSchema` together is still rejected on Anthropic/Bedrock, exactly the pre-existing behavior. On Gemini and OpenAI-compatible clients, the underlying provider APIs can represent structured output and tools independently, but before this PR the shared `VernLLM` guard prevented the combination from reaching those adapters; this PR removes that unnecessary orchestration-level restriction. `schema` remains client-side validation and is no longer part of the generic `tools` exclusion.

  Each provider's native mechanism has a narrower field set than the legacy forced-tool-call path, matched exactly to what each provider's real API accepts, verified against the real `@anthropic-ai/sdk` and `@aws-sdk/client-bedrock-runtime` clients rather than just asserted internally. Anthropic's `output_config.format` sends only `type` and `schema`, no `name`/`description`/`strict`. Bedrock's `outputConfig.textFormat` nests the schema one level deeper than every other schema shape these adapters build, under `structure.jsonSchema`, and requires `schema` there as a JSON-encoded _string_, not the parsed object used everywhere else in the adapter; `name`/`description` are accepted there, but not `strict`.

  The generic `VernLLM.call()`-level guard that used to reject `tools` + `jsonSchema`/`schema` unconditionally has been removed; the check is now left to each adapter, which has the model-specific capability information the orchestration layer doesn't. As a side effect, this also fixes Gemini: its `responseSchema` and `tools` are independent fields, so the adapter can now send both, and OpenAI-compatible clients already pass both fields through independently. The actual compatibility change is therefore that the shared orchestration layer no longer blocks combinations that individual adapters/providers can support, while Anthropic/Bedrock retain validation on models without native structured-output support.

  Also fixed a bug, on Anthropic and Bedrock, where `tools` was silently dropped from the request whenever `response_format: 'json_object'` was also set, reachable via `jsonMode: true` or `schema` (without `jsonSchema`) alongside `tools`. The JSON-instruction branch and the tool-building branch were structured as a single `if`/`else if` chain, so setting both meant only the JSON instruction was applied and `tools` never reached the wire request, even though nothing about a `json_object` prompt instruction actually conflicts with `tools`/`toolConfig`. The two are now built independently.

  `AnthropicAdapterOptions`, `BedrockAdapterOptions`, and `ModelCapabilityOverride` are now exported from the package root (previously `BedrockAdapterOptions` was never exported either, a pre-existing gap this also closes), so `nativeStructuredOutputModels` and `toolUseSupportedModels` can be typed and referenced directly instead of relying on structural inference at the `fromAnthropic`/`fromBedrock` call site.

  Docs updated: `core/tool-calling.mdx` and `core/structured-output.mdx` no longer describe `tools`/`jsonSchema` as unconditionally mutually exclusive, and gained a "Combining with tools" section covering `nativeStructuredOutputModels` and each provider's exact native wire shape; `adapters/anthropic.mdx` and `adapters/bedrock.mdx` gained matching per-provider sections with usage examples and shape callouts; `API-reference/call-params.mdx` and `API-reference/notes.mdx` corrected to describe the new conditional (model-dependent) behavior instead of an absolute rule.

  Tests added covering: `jsonSchema` + `tools` together on a covered model (with and without real tools present), the exact native wire shape for both providers, the validation error naming the model on an uncovered model, the predicate form of `nativeStructuredOutputModels`, the legacy forced-tool-call path on an uncovered model (regression), `tools` alone on a covered model (regression), the `toolUseSupportedModels` preflight also firing on the native path when real `tools` are sent alongside `outputConfig` on Bedrock, and the `json_object` + `tools` bug fix on both adapters (regression). Also added real-SDK integration tests, driving an actual `@anthropic-ai/sdk` client and an actual `@aws-sdk/client-bedrock-runtime` client against a local mock server and asserting on the real wire body, for both providers' native path with real tools alongside it: these caught the wire-shape mismatches described above before release, which unit tests against hand-rolled fakes could not have caught on their own.

### Patch Changes

- 68c620f: Reorganized the package's internal file structure. No public API changes.

  `VernLLM` previously held request building, retry, the circuit breaker, the rate limiter, and cache orchestration all inline in one class. It now delegates to `CallExecutor` (request building, retry, breaker, limiter) and `CacheOrchestrator` (cache reads/writes and in-flight coalescing), leaving `VernLLM` itself as constructor wiring plus the public `call`/`cachedCall`/`deleteCache`/`getCircuitState` surface.

  `src/internal/` is now grouped by the subsystem that owns each file: `internal/execution/` for everything `CallExecutor` needs (`callExecutor.ts`, `requestBuilder.ts`, `streamAccumulator.ts`, `retry.utils.ts`, `errors.utils.ts`, `wire.utils.ts`, `parse.utils.ts`), `internal/cache/` for everything `CacheOrchestrator` needs (`cacheOrchestrator.ts`, `cache.utils.ts`, `replay.utils.ts`), and `internal/circuitBreaker.utils.ts`/`internal/usage.utils.ts` staying loose since `VernLLM` uses them directly. `sse.ts`, `imageFormat.ts`, and `nativeStructuredOutput.ts` moved under `src/adapters/internal/`, since the provider adapters are their primary consumers. `sse.ts` keeps its package-root exports, `parseSseStream` and `SSE_PING`, re-exported from `src/index.ts`.

  The streaming accumulator (chunk buffering, backlog eviction, live delivery to a waiting consumer) is now its own module, `streamAccumulator.ts`, taking `onStreamSuccess`/`onStreamFailure`/`finalize` callbacks instead of reaching back into `CallExecutor`'s breaker and usage reporting directly.

  Tests moved to mirror the new source layout, one test file's path following its source file's path. `tests/unit/vernLLM.utils.unit.test.ts` was split into `retry.utils.unit.test.ts`, `errors.utils.unit.test.ts`, and `usage.utils.unit.test.ts`, matching the source split. A new `streamAccumulator.unit.test.ts` exercises the accumulator directly against a hand-built chunk iterator, instead of only reaching it through a full `VernLLM` instance and a mock client.

## 2.0.0

### Major Changes

- c9c7414: Collapsed `cachedCall`/`cachedLLMCall` into a single public `cachedCall`.

  Previously `VernLLM` exposed two caching methods: a generic `cachedCall({ cacheKey, ttl, fn })` that cached whatever `fn` returned with no retry/timeout/circuit-breaker guarantees, and `cachedLLMCall({ cacheKey, ttl, call })` that composed `call()` (retry/timeout/circuit-breaker) with caching. This split didn't match vern-llm's "production-ready resilience for LLM calls" scope, and the generic form was really a general-purpose memoizer that happened to live on the LLM client.

  `cachedLLMCall` is renamed to `cachedCall`. The public `cachedCall()` now always composes `call()` internally, so cached results get the same retry/timeout/circuit-breaker behavior as any other LLM call. There is no longer a public way to cache an arbitrary non-LLM function through `VernLLM`. If you were using the old fn-based `cachedCall({ fn })` for general-purpose caching or coalescing unrelated to an LLM call, switch to a dedicated caching library (e.g. `async-cache-dedupe`) at the application level instead.

  Type renames to match:

  - `CachedLLMCallParams<T>` → `CachedCallParams<T>` (now the public type for `cachedCall()` without tools).
  - `CachedLLMToolCallParams<T>` → `CachedToolCallParams<T>` (public type for `cachedCall()` with tools).
  - The old generic `CachedCallParams<T>` (the `fn`-based shape) is no longer exported from the package.

  See the Migration Notes for details.

- 7cdfb6b: Added first-class tool calling support.

  `call()` now accepts `tools`, an array of `ToolDefinition`s the model may request, and an optional `toolChoice` to control whether and which tool is used. When `tools` is set, `call()` returns a `CallWithToolsResult<T>` discriminated union (`{ type: 'content', content }` or `{ type: 'tool_calls', toolCalls, content? }`) instead of `T` directly. VernLLM never executes tools itself, applications run them and continue the conversation by appending an assistant `toolCalls` turn and a matching `tool` turn to `history`.

  `fromAnthropic`, `fromBedrock`, `fromGemini`, and the OpenAI-compatible adapters all translate `tools`/`toolChoice`/`tool_calls` into that provider's native tool-calling mechanism. `fromFetch` supports tool calling too: `mapResponse` can return a `toolCalls` array alongside `content`. `cachedLLMCall()` supports tool-enabled calls the same way it supports plain ones.

  This is a major release because of two breaking type changes:

  - `ConversationTurn` is now a discriminated union instead of one flat `{ role, content }` shape, adding a `tool` case and making `content` optional on `assistant` turns. Constructing turns is unaffected; code that reads `turn.content` on an `assistant` turn assuming it's always a `string`, or that used an exhaustive `switch`/`assertNever` pattern over `role`, will need updating.
  - `LLMClient.messages` widened to include tool turns and `tool_calls` on assistant messages. This only affects hand-written `LLMClient` implementations that bypass the built-in adapters. Any such adapter that declares or processes the message type, not only ones with an exhaustive role switch, needs to update its types and handle tool messages and assistant `tool_calls` correctly.

  See the Tool Calling docs and Migration Notes for details.

### Minor Changes

- 94203cf: Improve provider SDK compatibility and adapter support across Anthropic, Gemini, OpenAI-compatible, and Bedrock providers. Adds stronger schema validation, streaming and cancellation handling, improved error handling, and expanded real-SDK integration coverage.
- 64839b2: Fixed several gaps in streaming (`stream: true`).

  Added a `chunkIdleTimeoutMs` option (default 30000ms, `0` disables it) that bounds the gap between chunks after the first. Previously only stream-open and the first chunk were bounded by `timeoutMs`, so a connection that streamed one chunk then hung would never fail. An idle-timeout failure now also trips the circuit breaker, unlike other mid-stream failures, since a provider that reliably streams one chunk then hangs would otherwise never trip it.

  Added `complete?: boolean` to `StreamChunk`/`WireStreamChunk`'s `tool_call_delta` variant. Gemini always delivers a `functionCall`'s arguments whole in one chunk, indistinguishable before now from a genuine fragment from other providers. Gemini's adapter and cache-replay chunks (`buildReplayChunks`) now set it.

  Chunk buffer eviction is now logged at debug level when a caller doesn't read `chunks` (or falls far behind), so missing chunks in a reconstructed stream can be traced back to eviction instead of looking like a transport bug.

  Added a `ping` variant to `WireStreamChunk` for provider keep-alive signals with no content. `fromFetch` (SSE comment-line pings, via a new exported `SSE_PING` sentinel) and `fromAnthropic` (Anthropic's documented `ping` events) both recognize these and reset the idle timer, instead of silently dropping them and risking a timeout on an actively alive long-running stream.

  This is purely additive. Existing callers, and adapters that don't emit `ping` or set `complete`, are unaffected.

- bc1fc46: Added `onUsageFailure`, an opt-in hook that reports token usage for calls that spent real tokens but then failed on VernLLM's own post-response handling, such as parse or schema validation errors, instead of silently dropping that spend.

  `onUsage` only fires on full success, so there was previously no way to know a failed call had still cost tokens. `onUsageFailure` fills that gap: it fires once per failed attempt when the provider response included usage data, receiving the same `TokenUsage` shape as `onUsage` plus the `LLMError` that caused the failure. It covers any error thrown after a response arrives, not just parse/validation, and is skipped for transport failures (timeout, network error, non-retryable status) and for calls that were aborted, since in both cases there is no usage to report or the error type would not match what `call()` ultimately throws.

  This is purely additive. `onUsage`'s existing contract is unchanged, and no action is needed for existing integrations.

  See the [Usage Tracking](https://vernllm.vercel.app/docs/core/usage-tracking) docs for the full shape and firing semantics.

- 56aeab6: Added streaming support to the generic `fromFetch` adapter.

  Three new optional `FetchAdapterConfig` fields wire up streaming for any OpenAI-compatible-shaped HTTP endpoint: `requestStream` opens the streaming HTTP request (defaults to native `fetch`), `parseStreamFrames` splits the raw response bytes into individual event payloads (defaults to Server-Sent Events framing), and `mapStreamEvent` maps one parsed event into zero, one, or more `WireStreamChunk`s. `mapStreamEvent` is required for `stream: true` calls; a config that omits it now throws a clear `LLMError('validation')` instead of failing silently or confusingly mid-stream.

  Also fixed a related correctness bug: `fromOpenAICompatible` and its aliases previously sent `stream_options: { include_usage: true }` unconditionally on every streamed call. Not every OpenAI-compatible provider supports that field, so a provider that rejects unrecognized parameters could fail every streamed call outright, which is what Mistral used to do. `stream_options` is now gated behind a new `supportsStreamUsage` adapter option, defaulting to `true`. This default was verified directly against provider docs for Groq, DeepSeek, Mistral, Perplexity, and LM Studio, all of which support the field, so existing callers keep getting usage in their stream exactly as before. Pass `{ supportsStreamUsage: false }` only for a provider you've confirmed rejects it.

  This is purely additive. Existing `fromFetch` configs without the new streaming fields, and existing OpenAI-compatible aliases, are unaffected.

- c536167: Added a way to opt out of VernLLM's `temperature: 0.2` default and let the provider apply its own default instead.

  Pass `temperature: null` on a call, or `defaultTemperature: null` on the `VernLLM` instance, and `temperature` is omitted from the request entirely rather than sent as `0.2`. A per-call `temperature` still wins over the instance-level `defaultTemperature`, which still wins over the `0.2` fallback, same resolution order as `maxTokens`/`defaultMaxTokens`.

  This is purely additive for normal `call()` usage. Omitting `temperature` everywhere keeps sending `0.2` exactly as before, no behavior changes for existing callers.

  One narrow caveat: making this work required widening `LLMClient`'s wire-level `temperature: number` to `temperature?: number`. This only affects hand-written `LLMClient` implementations that assume `params.temperature` is always a `number` without checking whether it's `undefined`, every built-in adapter (`fromAnthropic`, `fromBedrock`, `fromGemini`, `fromFetch`, OpenAI-compatible) is unaffected. See Migration Notes for details.

- 9fc3ee6: Added tool calling support to the generic `fromFetch` adapter.

  `mapResponse` can now return an optional `toolCalls` array alongside `content`: `{ id, name, arguments }` per call, with `arguments` already JSON-encoded as a string, the same wire format every other adapter produces. `fromFetch` translates these into `WireToolCall`s so `call()` surfaces them through `CallWithToolsResult` exactly like the built-in provider adapters. `mapRequest` already received the full request (including `tools`/`toolChoice`) before this change, so only the response side needed a new seam.

  `content` is now optional on `mapResponse`'s return type too, since a pure tool-call turn may have no text. An empty `toolCalls` array is treated identically to an omitted one, no special-casing needed either way.

  This is purely additive. Existing `fromFetch` configs that never set `tools` and return only `{ content, usage? }` from `mapResponse` are unaffected.

  See the Custom Providers docs for a full example.

## 1.7.1

### Patch Changes

- 2eff4ac: Removed openai as a peer dependency

## 1.7.0

### Minor Changes

- 837d9d1: Added an opt-in preflight check for Bedrock tool use support.

  `fromBedrock` now accepts a second `options` argument with `toolUseSupportedModels`, either a static list of model IDs or a predicate function. When set, a `jsonSchema` call to a model not covered by it fails fast with `LLMError('validation')` before the request is sent.

  Left unset, the default, no preflight check runs and a `jsonSchema` call to an unsupported model still surfaces Bedrock's raw error unchanged. `fromBedrock` does not try to reclassify or guess at that error from its text, since AWS's error message for an unsupported model is not a documented, stable contract.

  Also refactored `VernLLM.ts` internally: inlined several small constructor only helper methods, tightened redundant logic, and expanded JSDoc coverage across the public API (constructor, `call`, `cachedCall`, `cachedLLMCall`, `deleteCache`, `getCircuitState`) with clearer parameter and return descriptions. No public behavior changed.

  Docs updated in `adapters/bedrock.mdx` with a new "Preflighting tool use support" section.

  Tests added covering the allowlist and predicate forms of `toolUseSupportedModels`, confirming `converse` is never called on a rejected preflight, and confirming non `jsonSchema` calls and the no option default skip the check entirely.

- 52d5f74: Added an extensible cache adapter framework that allows applications to customize and compose caching strategies.

  Added `resolveKey` support to `CacheAdapter` for canonicalizing cache keys before lookups and in-flight request coalescing.
  Cache adapters can now transform equivalent but differently formatted keys into a shared canonical key, allowing requests such as normalized, semantic, or fuzzy matches to reuse the same cached response and active generation.
  This enables advanced cache matching strategies without changing VernLLM's core caching flow, while keeping existing adapters fully compatible through the optional `resolveKey` method.

  Included built-in adapters:

  - `InMemoryCacheAdapter` for zero-dependency local caching with TTL support and bounded memory usage.
  - `NormalizedCacheAdapter` for normalizing cache keys to avoid duplicate entries caused by formatting differences.
  - `TieredCacheAdapter` for multi-level caching with fast local L1 caches and shared L2 caches, including promotion of L2 hits back into L1.

  This enables support for advanced caching architectures such as local + distributed caches, custom cache providers (Redis, Upstash, databases, etc.), and future semantic or fuzzy cache implementations without changing VernLLM's core execution flow.

  Docs has been update within guides to showcase these new adapters.
  Tests has been added on `cachedCall.unit.test.ts` and `index.exports.unit.test.ts`

### Patch Changes

- 426d48e: Internal refactor: extract `withReservedUsage` and `normalizeError` out of `VernLLM` into `internal/vernLLM.utils.ts` as standalone functions, with added unit test coverage. No public API or behavior changes.
- 02e8df9: Fix cache key normalization, tiered cache key resolution, and structured output adapter metadata forwarding.

  - **`NormalizedCacheAdapter`**: punctuation is now replaced with a space instead of being removed outright. Previously `"2+2"` and `"2 + 2"` normalized differently (`"22"` vs `"2 2"`) because removing punctuation collapsed adjacent characters. Both now normalize consistently to `"2 2"`.

  - **`TieredCacheAdapter`**: now implements `resolveKey`, forwarding to L1's implementation if present, otherwise L2's, otherwise returning the original key unchanged.

  - **`fromAnthropic`**: `jsonSchema` now forwards schema metadata into Anthropic tool use. The adapter passes `name`, `description`, `input_schema`, and `strict` into the generated tool definition and continues using forced tool calls for structured output.

  - **`fromBedrock`**: `jsonSchema` now forwards schema metadata into Bedrock Converse tool use. The adapter passes `name`, `description`, `inputSchema`, and `strict` into the generated tool spec and forces tool selection through `toolChoice`. Strict enforcement depends on the selected Bedrock model's tool support.

  - **`fromGemini`**: `jsonSchema` now forwards schema descriptions into Gemini's `generationConfig.responseSchema`. Structured output uses `responseMimeType: 'application/json'` with `responseSchema`; Gemini does not use a separate `strict` flag.

  - Removed references to the deprecated `@google/generative-ai` SDK from Gemini adapter docs and comments. The adapter uses structural typing and is not SDK-specific.

  Docs updated in:
  `core/caching.mdx`, `guides/caching-methods/normalized.mdx`, `guides/caching-methods/tiered.mdx`, `core/structured-output.mdx`, and `adapters/gemini.mdx`.

  Tests added covering punctuation normalization, `TieredCacheAdapter.resolveKey` forwarding, and structured output adapter behavior.

## 1.6.0

### Minor Changes

- 09b75c0: Improve usage metering, cancellation handling, and reliability across call paths.

  - Add abort signal support to cached call flows and usage metering hooks.
  - Expose `{ coalesced, signal }` to usage reservation and refund callbacks.
  - Ensure reservations are only refunded when successfully created, including cancelled requests.
  - Centralize usage reservation and refund handling across `call()`, `cachedCall()`, and `cachedLLMCall()`.
  - Fix circuit breaker accounting so validation, parsing, and caller cancellation failures do not count as provider failures.

- babe641: Improve usage metering lifecycle handling across request paths.

  - Add usage reservation and refund support to cached call flows without duplicating logic.
  - Add abort-aware usage hooks with `{ coalesced, signal }` context.
  - Refund successful reservations when requests are cancelled before execution begins.
  - Improve reservation and refund failure handling without changing call error semantics.
  - Prevent validation, parsing, and caller cancellation errors from being recorded as circuit breaker failures.

### Patch Changes

- bdee813: Fix `refundUsage` being called even when the corresponding `reserveUsage` call itself failed.

  Previously, if `reserveUsage` threw (e.g. quota already exhausted), `refundUsage` would still fire for that caller, incorrectly refunding a reservation that was never actually made. `refundUsage` is now only invoked if `reserveUsage` succeeded, for both the triggering caller and coalesced callers in `cachedCall`/`cachedLLMCall`.

## 1.5.0

### Minor Changes

- 20591dc: `LLMError` now preserves the original error thrown by the provider client, instead of discarding it once the status code has been extracted.

  **Changes:**

  - **`LLMError`**: added two new optional fields, `cause` and `retryAfterMs`. `cause` carries the raw
    value thrown by the underlying client (the actual SDK/HTTP error), so consumers can inspect the
    provider's real rejection reason (message, response body, etc) even though the top-level
    `LLMError` message stays a generic `'LLM request failed'`. `retryAfterMs` carries the parsed
    `Retry-After` value (if any) from the last failed attempt, using the same delta-seconds/HTTP-date
    parsing and cap already used internally for backoff.

  - **`normalizeError`**: now attaches both fields when building the final thrown `LLMError` for
    `'api'` and `'unknown'` error types. Existing consumers checking `.type`/`.status`/`.issues` are
    unaffected — this is purely additive.

  - **`debug` logging**: previously `logger.debug` only fired on a successful response. It now also
    fires on the failure path via a new `describeError()` helper, logging the provider's actual
    rejection reason (`.error` or `.message`) before the normalized `LLMError` is thrown. This makes
    `debug: true` useful for diagnosing failed calls, not just inspecting successful output.

  - **Tests**: added coverage in `vernLLM.call.unit.test.ts` for `.cause` being preserved on both
    `'api'` and `'unknown'` errors, and for `.retryAfterMs` being surfaced on the final thrown error.

  - **Docs**: updated `core/error-handling.mdx` (new `.cause`/`.retryAfterMs` fields, corrected the
    now-outdated callout claiming the raw error wasn't preserved, added a "Debugging a failed call"
    section) and `core/logging.mdx`/`API-reference/configuration.mdx` (`debug` now also covers the
    failure path; also fixed an unrelated pre-existing docs bug incorrectly stating `debug` defaults
    to `NODE_ENV !== 'production'` when the actual default is `false`).

### Patch Changes

- 8dbd711: Throw `LLMError('validation')` when `schema` is combined with `jsonMode: false` (without `jsonSchema`), instead of silently skipping validation and returning an unvalidated string cast to the schema's type.
- 4d0366f: update install section on readme

## 1.4.0

### Minor Changes

- 95b1a36: Coalesce concurrent `cachedCall` misses for the same `cacheKey` into a single `fn()` call.

  Previously, every concurrent request for the same `cacheKey` that missed the cache independently
  called `fn()`, causing a cache stampede: N simultaneous callers could trigger N calls to the
  underlying (possibly expensive) LLM call before any of them had a chance to populate the cache.

  Now only the first caller (the "trigger") calls `fn()`; every other concurrent caller for the same
  key waits on that same in-flight call and shares its result or failure.

  `reserveUsage`/`refundUsage` now receive a `{ coalesced: boolean }` argument, so applications can
  decide how coalesced callers are billed: full price, a reduced rate, or not billed at all. This is
  backward compatible — existing `() => Promise<void>` implementations don't need to change.

  Docs updated in `core/caching.mdx` to describe the coalescing behavior and the new `coalesced` flag.

- 480e0c6: Honor a `Retry-After` header on retryable failures instead of always using exponential backoff.

  **Changes:**

  - **Core**: Added `extractRetryAfterMs()` in `internal/vernLLM.utils.ts`, which reads `.headers`
    (fetch-style) or `.response.headers` (axios-style) off a thrown error and parses `Retry-After` in
    either delta-seconds (`"30"`) or HTTP-date form. `getBackoffDelay`'s previously-inline `10_000`
    default is now the shared `DEFAULT_MAX_DELAY_MS` constant, also used to cap the honored
    `Retry-After` value so a misbehaving/adversarial header can't stall a caller indefinitely.

  - **`recoverDelay`**: now uses `extractRetryAfterMs(error) ?? getBackoffDelay(...)`, falling back to
    today's exponential-backoff-with-jitter exactly as before when no usable header is present. No
    adapter changes needed — headers already flow through on thrown errors (fetch adapter via the
    prior `request`/headers PR, SDK-based adapters natively).

  - **Tests**: added `tests/unit/vernLLM.utils.unit.test.ts` for `extractRetryAfterMs` (delta-seconds,
    HTTP-date, axios vs Headers-like shapes, capping, past-date clamping, missing/unparseable header),
    plus end-to-end retry tests in `vernLLM.call.unit.test.ts` (honors Retry-After over a larger
    configured backoff, caps an oversized Retry-After, falls back to backoff when absent).

- eca6cf2: Improve the `fetch.ts` adapter: allow an injectable `request` function (defaults to native
  `fetch`) typed against a `ResponseLike` interface for interop with axios/node-fetch/etc, skip
  `body`/`Content-Type` for GET/HEAD requests, and attach `res.headers` to thrown errors so
  downstream retry logic can read `Retry-After`.

  Minor bump: fully additive, no changes to existing `fromFetch` call signatures or behavior for
  POST/PUT/PATCH.

- 06c5297: Add multimodal input support through `userContent`.

  `userContent` now accepts either a plain string or a `ContentBlock[]` array containing text and image
  blocks. Existing string-based calls continue to work unchanged.

  Image blocks are translated automatically by provider adapters:

  - OpenAI-compatible providers pass through native multimodal content.
  - Anthropic converts image blocks to image source blocks.
  - Gemini converts image blocks to inline data parts.
  - AWS Bedrock converts image blocks to Converse image content blocks.

  This enables sending images alongside text while keeping the existing text-only API backwards
  compatible.

### Patch Changes

- 1ed6246: Fix circuit breaker allowing multiple concurrent trial calls during half-open.

  `assertClosed()` transitioned the circuit to `half-open` once the cooldown elapsed, but every
  concurrent caller after that point was also let through unblocked, since the guard only checked
  for `state === 'open'`. This meant several "trial" calls could hit the provider at once right when
  the cooldown ended, instead of the intended single trial.

  Added a `trialInFlight` flag: only the first caller during half-open becomes the trial and reaches
  the provider; every other concurrent caller is rejected immediately with `circuit_open` until the
  trial's outcome is recorded via `recordSuccess`/`recordFailure`.

## 1.3.0

### Minor Changes

- f1c238f: Fix default behaviors that didn't match the library's intended resilience/logging guarantees.

  - **`nonRetryableStatus`**: default extended from `[400, 401, 403]` to `[400, 401, 403, 404, 422]`.
    404/422 can never succeed on retry, so retrying them was always wasted.
  - **Debug logging**: no longer defaults to on when `NODE_ENV !== 'production'`. Now defaults to
    `false`, since debug logging can output raw response content and many environments never set
    `NODE_ENV` explicitly. Opt in via `debug: true`.
    - **Unit tests**: added for the debug logger
  - Docs updated to match (`error-handling.mdx`, `logger.mdx`).

  Minor bump: changes default behavior for existing consumers, but explicit `debug`/
  `nonRetryableStatus` settings are unaffected.

## 1.2.0

### Minor Changes

- 690f7f3: Add named adapter aliases for additional OpenAI-compatible LLM providers.

  **Changes:**

  - **Source**: Added new provider aliases for additional OpenAI-compatible providers, all backed by `fromOpenAICompatible` with zero request/response transformation.
  - **Adapters**: Added support for providers including xAI, NVIDIA NIM, Vercel AI Gateway, Cloudflare Workers AI, GitHub Models, Nebius, SambaNova, Baseten, DashScope, Featherless, Friendli, SiliconFlow, LiteLLM Proxy, Parasail, StepFun, MiniMax, Lambda Labs, Snowflake Cortex, Anyscale, Lepton, kluster.ai, Inference.net, Infermatic, AtlasCloud, and 01.AI.
  - **Docs**: Expanded `openai-compatible` documentation with the full list of supported named adapters and clarified `fromOpenAICompatible()` as the generic fallback.
  - **Homepage**: Updated the provider list with the newly supported providers.
  - **Changeset**: Minor bump for `vern-llm` — purely additive, no breaking changes.

## 1.1.0

### Minor Changes

- b46d6f7: Added named adapter aliases for 9 more OpenAI-compatible LLM providers to `vern-llm`: OpenRouter, Perplexity, DeepInfra, Novita, Hyperbolic, Moonshot, Zhipu, LM Studio, and vLLM.

  **Changes:**

  - **Source**: `fromOpenRouter`, `fromPerplexity`, `fromDeepInfra`, `fromNovita`, `fromHyperbolic`, `fromMoonshot`, `fromZhipu`, `fromLMStudio`, `fromVLLM` added as aliases for `fromOpenAICompatible` in `packages/vern-llm/src/adapters/openaiCompatible.ts`, re-exported via `adapters/index.ts` and `src/index.ts`
  - **Tests**: added to the parameterized alias check in `openaiCompatible.unit.test.ts` (18/18 passing)
  - **Docs**: `adapters/index.mdx` and `adapters/openai-compatible.mdx` updated to list all providers as named wrappers
  - **Homepage**: `home.utils.ts` `providers` array expanded with icons + doc links for all new providers (fixed `Vllm` casing to match actual `@lobehub/icons` export)
  - **Changeset**: minor bump for `vern-llm` — purely additive, no breaking changes

  **Verified**: `tsc --noEmit` clean on both the package and docs app, `dist/` rebuilt via `tsdown` to include new exports, `changeset status` confirms minor bump.

## 1.0.0

### Major Changes

- 96a29f4: **Breaking: `CacheAdapter.get()` now returns `Promise<{ hit: boolean; value: T | null }>` instead of `Promise<T | null>`.**

  This lets `cachedCall`/`cachedLLMCall` correctly distinguish a cache miss from a legitimately cached `null` value, so a valid `null` result is now reused from cache instead of being treated as a miss and re-triggering an LLM call.

  `InMemoryCacheAdapter` (the built-in default) is updated automatically — no action needed if you're using it. If you've implemented a custom `CacheAdapter` (Redis, Upstash, or otherwise), you'll need to update its `get()` method. See the migration guide below.

  Also in this release:

  Make `CallParams.systemPrompt` optional and omit system messages when unset.
  Export `AnthropicClient`, `GeminiClient`, and `BedrockConverseClient` as public types.
  Add an `adapters` barrel export for provider adapters.
  Refactor internal types into focused modules.
  Add regression and integration test coverage for optional system prompts and adapter behavior.
  Add Anthropic adapter coverage to verify provider payloads omit `system` when `systemPrompt` is not provided.
  Add cache adapter test coverage for custom adapter support, cache size bounds, and cache failure handling.
  Add in-memory cache size limiting to prevent unbounded growth.
  Bump the major version to reflect the breaking `CacheAdapter.get()` change.

  ## Migration guide

  ### `CacheAdapter.get()`

  **Before:**

  ```ts
  class MyCacheAdapter implements CacheAdapter<MyValue> {
    async get(key: string): Promise<MyValue | null> {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : null;
    }
    // ...
  }
  ```

  **After:**

  ```ts
  class MyCacheAdapter implements CacheAdapter<MyValue> {
    async get(key: string): Promise<{ hit: boolean; value: MyValue | null }> {
      const raw = await redis.get(key);

      if (raw === null) {
        return { hit: false, value: null };
      }

      return { hit: true, value: JSON.parse(raw) };
    }
    // ...
  }
  ```

  The key change: `hit` should be `true` whenever the key existed in the underlying store (even if the stored value itself is `null`), and `false` only when nothing was found. Most adapters can derive this directly from whatever "does this key exist" signal their underlying store already gives them (e.g. Redis returning `null` vs. a real value, or an `EXISTS` check).

  If you don't want to implement the distinction and are fine with `null` results simply never being served from cache, you can also just return `{ hit: value !== null, value }` from your existing `get()` logic as a drop-in shim.

## 0.5.0

### Minor Changes

- 037e8ee: Add delete cache functionality to vernLLM

### Patch Changes

- e18b37e: add keywords to package

## 0.4.0

### Minor Changes

- 5e029b2: Add support for multi-turn conversation history via the `history` option in `CallParams`. Conversation history is now forwarded to all supported providers, including assistant messages, enabling native multi-turn interactions.

## 0.3.0

### Minor Changes

- 761d860: Make LLM throw LLMerror(timeout) when timeout aborts request

### Patch Changes

- afd54d9: Affirm directory on package

## 0.2.1

### Patch Changes

- ee5bb90: Connect repo with package

## 0.2.0

### Minor Changes

- dbce6e2: created a `tsconfig.base.json` which the `tsconfig.json` extends from
