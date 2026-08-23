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

This only applies when TypeScript can see the exact tools at the `call()`/`cachedCall()` call site, the same requirement already documented for the tools-aware overload. Tools passed through a variable, built conditionally (`tools: someCondition ? [weatherTool] : undefined`), or declared without `defineTool()` still work at runtime, but `arguments` falls back to `unknown` in those cases, same as before this change. Nothing about runtime behavior changes: validation, parsing, and error handling for tool arguments are unaffected.
