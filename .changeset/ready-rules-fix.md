---
'vern-llm': minor
---

`call()` and `cachedCall()` return better types for JSON mode.

Before, `jsonMode: false` still typed the result as `unknown`, even though the runtime value was always a `string`:

```ts
const response = await llm.call({
  userContent: 'Hello',
  jsonMode: false,
});
// response: unknown, but really a string
```

Now the return type matches the requested mode:

```ts
const response = await llm.call({
  userContent: 'Hello',
  jsonMode: false,
});
// response: string

const parsed = await llm.call({
  userContent: 'Hello',
  jsonMode: true,
});
// parsed: JsonValue
```

`JsonValue` is a new exported type for any valid JSON shape:

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
```

A call site that also sets `schema` still gets `T` inferred from the schema, exactly as before. This overload change only affects calls that don't use `schema`. Streaming calls (`stream: true`) get the same treatment: `finalResult` now resolves to `string`/`JsonValue` instead of `unknown` for the same two `jsonMode` cases, for both `call()` and `cachedCall()`.

`ConversationTurn` assistant `content` now also accepts a parsed `JsonValue`, so a `jsonMode: true` result can be pushed straight into `history` without stringifying it yourself:

```ts
import type { ConversationTurn } from 'vern-llm';

const history: ConversationTurn[] = [];

const parsed = await llm.call({ userContent: 'Give me a JSON summary.', jsonMode: true });

history.push(
  { role: 'user', content: 'Give me a JSON summary.' },
  { role: 'assistant', content: parsed },
);
```

VernLLM's request construction `JSON.stringify`s non-string assistant `content` before it's sent as part of the wire request, so no manual stringifying is needed on the caller's side.
