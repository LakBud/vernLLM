---
'vern-llm': minor
---

Add `requireRef` and `RequiredMiddlewareRef` for mandatory `runsAfter`/`runsBefore` dependencies.

A bare `MiddlewareRef` in `runsAfter`/`runsBefore` stays optional: if it doesn't resolve, `VernLLM` warns and continues. Wrap a ref with `requireRef` to make it mandatory instead: if it doesn't resolve, construction throws immediately, naming the missing dependency.

```ts
import { createMiddlewareRef, requireRef, type VernLLMMiddleware } from 'vern-llm';

const moderationRef = createMiddlewareRef('moderation');

const logging: VernLLMMiddleware = {
  name: 'logging',
  runsAfter: [requireRef(moderationRef)], // must run after moderation, no exceptions
};
```

Purely additive. `runsAfter`/`runsBefore` still accept bare `MiddlewareRef`s unchanged; nothing existing needs to change.
