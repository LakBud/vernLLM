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

await aws([{ text: 'Mail jane@acme.com', source: 'user' }], signal);
// [{ segment: 0, label: 'pii.EMAIL', start: 5, end: 18 }]

aws.only('pii', 'topic'); // a detector for some kinds, over the same requests and cache
```

It makes one request per text however many views read it, splits long texts into chunks, and limits requests in flight with `concurrency`. The cache keeps labels and offsets, never text. A `DRAFT` version warns once and is never cached, since it can change. Any error, or a response without assessments, is thrown as it is.

Nothing changes for existing code: it is a new entry point, so `fromBedrock` and the size of the root bundle stay as they were.
