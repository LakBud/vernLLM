---
'vern-llm': minor
---

`fromBedrock` now accepts a raw AWS SDK v3 client directly. It takes either a hand-written
`BedrockConverseClient` (`.converse()`/`.converseStream()`) or a real `BedrockRuntimeClient`
(anything with `.send()`), and detects which one it got. No wrapper is required for the latter:

```ts
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { VernLLM, fromBedrock } from 'vern-llm';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });

const llm = new VernLLM({
  client: fromBedrock(client),
  model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
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
