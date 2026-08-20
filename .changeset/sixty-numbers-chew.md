---
'vern-llm': minor
---

`fromGemini` now accepts the whole `@google/genai` client, not just `ai.models`, and unwraps
`.models` internally:

```ts
import { GoogleGenAI } from '@google/genai';
import { VernLLM, fromGemini } from 'vern-llm';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const llm = new VernLLM({
  client: fromGemini(ai),
  model: 'gemini-2.5-flash',
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
