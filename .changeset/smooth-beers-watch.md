---
'vern-llm': patch
---

`call()`/`cachedCall()` (including their `stream: true` variants) no longer silently mistype a
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
`tools` was a literal array or a variable. Only the _type_ was wrong — `tools: ToolDefinition[] |
undefined` matched neither the tools-enabled nor the tools-disabled overload, so TypeScript fell
through to the final generic overload and typed the result as plain `T`.

This adds a `ConditionalToolCallParams<T>` overload (and cached/streaming counterparts
`CachedConditionalToolCallParams<T>`, `CachedStreamConditionalToolCallParams<T>`) that catches this
shape and returns the honest union instead. It's picked up automatically; no code changes are
needed to benefit from it, as long as `tools`'s narrower type reaches `call()` intact (an inline
literal, or a variable that hasn't been widened by an explicit `: CallParams<T>` annotation — see
below). Call sites using a literal `tools: [...]` array are unaffected and keep inferring
`CallWithToolsResult<T>` directly, same as before. Call sites that omit `tools` entirely are also
unaffected, since tools genuinely cannot have run there.

**New exports: `defineCallParams()` / `defineCachedCallParams()`.** A `: CallParams<T>` variable
annotation widens `tools` away before it ever reaches `call()`, no overload fix can recover from
that (it's how TypeScript's type annotations work, not a gap in this library). These two are
identity functions — return exactly what you pass them — for building a `call()`/`cachedCall()`
params object in a named, reusable variable without hitting that trap:

```ts
import { defineCallParams } from 'vern-llm';

const params = defineCallParams({
  userContent: 'What is the weather?',
  tools: someCondition ? [weatherTool] : undefined,
});

const result = await llm.call(params);
// result: unknown | CallWithToolsResult<unknown>, exactly as if `params`
// had been passed to call() inline.
```

They work by giving `P` (the whole params object) a single, plain generic parameter — no `const`
type parameter needed. TypeScript 5.0's `const` type parameters would also solve this, but they'd
silently raise this package's effective minimum TypeScript version (this package declares none
today, and the whole package's `.d.ts` would fail to parse on TypeScript <5.0, not just these two
functions), and turned out to be unnecessary here anyway: `tools: someCondition ? [tool] :
undefined`'s type is already the union the ternary computes, not a literal that needs `const` to
avoid being widened. `T` isn't a parameter of `defineCallParams()` itself; pin it the normal way,
via `llm.call<T>(params)`, exactly as you would with an inline object. `satisfies CallParams<T>`
remains a valid, import-free alternative to `defineCallParams()` for the same purpose.

`isToolCallResult()` was already the documented way to narrow a dynamically-typed result; this
change makes TypeScript require that check for the conditional-tools case instead of only
recommending it in a doc comment.
