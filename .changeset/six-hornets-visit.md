---
'vern-llm': patch
---

`ToolCall.arguments` is now typed per tool instead of `unknown`, when TypeScript can see the exact tools passed to `call()`/`cachedCall()`.

`ToolDefinition` is generic over the tool's `name` and its `argumentsSchema`'s inferred argument type. A new `defineTool()` helper preserves a tool's literal `name` (without requiring `as const`), which is what lets a `ToolCall` be matched back to the tool that produced it:

```ts
import { z } from 'zod';
import { defineTool } from 'vern-llm';

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  argumentsSchema: z.object({ city: z.string() }),
});

const result = await llm.call({ userContent: 'What is the weather?', tools: [weatherTool] });

if (result.type === 'tool_calls') {
  const call = result.toolCalls[0];
  call.arguments.city; // typed as string, no cast or re-parse needed
}
```

With more than one tool in the array, `arguments` is a discriminated union keyed by `name`; narrowing on `call.name` (`if (call.name === 'get_weather')` or a `switch`) is required before accessing a tool-specific field, the same way `isToolCallResult()` narrows `call()`'s own result union today.

This only applies when TypeScript can see the exact tools at the `call()`/`cachedCall()` call site. A plain `const tools = [weatherTool, cancelOrder]` variable (assigned once, not conditionally, without its own type annotation) still narrows correctly when passed through, same as an inline array literal. Conditional tools (`tools: someCondition ? [weatherTool] : undefined`) also narrow correctly: `isToolCallResult()` is now generic and infers `Tools` from the result automatically in this case, no type argument needed. `arguments` falls back to `unknown` in three cases, all variations on TypeScript no longer having the literal tool objects to work with: the `tools` variable itself is explicitly annotated (`const tools: ToolDefinition[] = [...]`), the params object carries an explicit `: CallParams<T>` annotation, or `T` is pinned explicitly (`call<string>(...)`) alongside a literal `tools` array, TypeScript's own generic inference rules suppress inference for every subsequent type parameter once any leading one is explicit, not something specific to this library. Pass `Tools` explicitly to `isToolCallResult<typeof tools>()` (for the first two cases) or to `call<T, Tools>()`/`cachedCall<T, Tools>()` (for the third), or route through `defineCallParams()` instead of a `:` annotation, to recover typing in each case. Nothing about runtime behavior changes: validation, parsing, and error handling for tool arguments are unaffected.
