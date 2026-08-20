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

A call site that also sets `schema` still gets `T` inferred from the schema, exactly as before. This overload change only affects calls that don't use `schema`.

`ConversationTurn` assistant `content` now also accepts a parsed `JsonValue`, so a `jsonMode: true` result can be pushed straight into `history` without stringifying it yourself:

```ts
const history: ConversationTurn[] = [];

const parsed = await llm.call({ userContent: 'Give me a JSON summary.', jsonMode: true });

history.push(
  { role: 'user', content: 'Give me a JSON summary.' },
  { role: 'assistant', content: parsed },
);
```

Adapters `JSON.stringify` non-string assistant content internally before sending it to the provider, so this is purely a type-level ergonomics change: the wire format is unaffected.
