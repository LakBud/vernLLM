---
'vern-llm-bedrock': minor
---

`vern-llm-bedrock/guardrail` adds `bedrockGuardrail()`, a detector that runs text through an Amazon Bedrock guardrail with `ApplyGuardrail`.

A detector is a function from text segments to findings. A finding is labeled `pii.<type>`, `regex.<name>`, `word.<type>`, `topic.<name>` or `content.<type>`. Matches from sensitive information, regexes and word lists are located in the text and become spans. Topics and content filters return no match, so they cover the whole text. Bedrock's own action is ignored, so the caller decides what a finding means, and a guardrail in detect mode works too.

```ts
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { bedrockGuardrail } from 'vern-llm-bedrock/guardrail';

const aws = bedrockGuardrail({
  client: new BedrockRuntimeClient({ region: 'eu-west-1' }),
  guardrailIdentifier: 'gr-abc123',
  guardrailVersion: '3',
});

const signal = AbortSignal.timeout(5000);
await aws([{ text: 'Mail jane@acme.com', source: 'user' }], signal);
// [{ segment: 0, label: 'pii.EMAIL', start: 5, end: 18 }]

aws.only('pii', 'topic'); // a detector for some kinds, over the same requests and cache
```

Views and calls share the requests in flight and the cached results, so a text is not sent again while its result is cached. A cache miss makes one request per chunk of a long text, and requests in flight are limited by `concurrency`. The cache keeps labels and offsets, never text. A `DRAFT` version warns once and is never cached, since it can change. Any error, or a response without assessments, is thrown as it is.

Nothing changes for existing code: it is a new entry point, so `fromBedrock` and the size of the root bundle stay as they were.
