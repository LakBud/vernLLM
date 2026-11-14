<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-guard.png" alt="vern-llm-guard logo" width="96" />
</p>

<h1 align="center">vern-llm-guard</h1>

<p align="center">Checks on what goes into a <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> call: label it for policy, redact values before the provider sees them, or block it.</p>

Prompts carry whatever your users and tools put in them: emails, card numbers, API keys, and text from web pages that tries to give the model orders. `vern-llm-guard` is one middleware that looks at the text of a call, on the way in and on the way out. A check finds values with a detector, and then labels the call for policy, replaces the values with tokens before the provider sees them, or refuses the call.

## Installation

```bash
npm i vern-llm-guard
```

`vern-llm` is a peer dependency, and the package has no other dependency.

## Quick start

```ts
import { VernLLM } from 'vern-llm';
import { guardMiddleware, keywords, patterns } from 'vern-llm-guard';

const guard = guardMiddleware({
  version: '2026-10-25.1',
  checks: [
    { id: 'pii', detect: patterns(['email', 'phone', 'card', 'iban']) },
    { id: 'secrets', detect: patterns(['secrets']), action: 'block' },
    { id: 'banned', detect: keywords(['project-x']), action: 'block', mode: 'audit' },
  ],
});

const llm = new VernLLM({ client, model, middleware: [guard] });
```

A call that holds an API key fails with `content_blocked` before a provider is contacted, with no budget reserved. A call with an email is labeled `pii`, which policy can use. `project-x` is only reported, since that check is in audit.

## What each action does

| Action            | Effect                                                                                |
| ----------------- | ------------------------------------------------------------------------------------- |
| `label` (default) | The call goes on unchanged, and policy can pick targets by the label                  |
| `redact`          | Each value becomes a token before the provider sees it, and is restored in the answer |
| `block`           | The call fails with `content_blocked`, never retried and never falling back           |

Redaction, end to end:

```text
caller sends     Write to jane@acme.com
provider sees    Write to x3f9a1c@redacted.invalid
caller receives  Mail sent to jane@acme.com
```

Tokens are keyed HMACs, so the same value always gets the same token and nothing is stored in a vault. An email token stays shaped like an address, so validators still pass.

## What it does and does not do

| Guard does                                                     | Guard does not                                          |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| Check the request, the answer and a stream, in one place       | Guarantee that nothing sensitive reaches a provider     |
| Label a call so policy can pick targets by what the call holds | Choose a target, or remove one: that is policy          |
| Redact values with keyed tokens and restore them in the answer | Keep a vault of values: nothing is stored               |
| Fail closed when a detector breaks                             | Scan images, or text another process added after it ran |
| Report counts, kinds and timings, never content or offsets     | Detect prompt injection reliably                        |

The built in detectors are heuristics, so run a new check in `mode: 'audit'` before it can block.

## Usage

### Redacting per target

```ts
const guard = guardMiddleware({
  version: '1',
  key: process.env.GUARD_KEY, // 32 bytes or more, optional
  checks: [{ id: 'pii', detect: patterns(['email', 'card']), action: 'redact' }],
});
```

`redactFor` runs per attempt, so a trusted primary can see the raw value while a fallback gets only the token. The caller's input is never changed: only a copy goes to the provider.

### Checking answers and streams

A check with `on: 'output'` runs on the answer, tool call arguments included. Streams go through the same steps as they arrive: text is released only after every check covering it passed, and a hold window catches a value split across chunks.

### Slow classifiers without the latency

```ts
{ id: 'jailbreak', detect: llamaGuard, action: 'block', parallel: true }
```

A `parallel` check starts with the call instead of before it, so calls that pass pay no extra latency. The answer is held until the check finishes.

### Detectors

| Detector                             | Finds                                                                             | Sends text to |
| ------------------------------------ | --------------------------------------------------------------------------------- | ------------- |
| `patterns([...])`                    | Email, phone, card, IBAN, IP, and secrets, with validation (Luhn, mod 97)         | Nowhere       |
| `keywords(list)`                     | Your own terms                                                                    | Nowhere       |
| `openaiModeration({ client })`       | Harmful content categories                                                        | OpenAI        |
| `llmClassifier({ llm, categories })` | Rules only you can describe, such as "names a competitor"                         | Your model    |
| `bedrockGuardrail({ ... })`          | Guardrails your team manages in Amazon Bedrock, from `vern-llm-bedrock/guardrail` | Bedrock       |

A detector is a plain function from text segments to findings, so you can write your own.

### Spotlight

`spotlight: { sources: ['tool'] }` is an opt in defence against prompt injection from untrusted text. It marks that text and tells the model that marked text is data and never instructions, without breaking provider prompt caching. It changes what the model reads, so test it on your own use case first.

### Trying a check before you ship it

```ts
const result = await guard.evaluate({ text: 'Mail jane@acme.com' });
// result.outcome is 'labeled', result.labels is ['pii']
```

`evaluate` runs the real detectors on plain data with no provider and no network. Run it over a labeled set in CI to measure false positives before a check leaves audit.

### Labels for policy

```ts
import { guardLabels } from 'vern-llm-guard';
import { policyMiddleware } from 'vern-llm-policy';

const policy = policyMiddleware({
  labels: guardLabels,
  rules: [{ id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } }],
});
```

Every call emits one `guard.result` event with the outcome, labels, and counts per check. Never content, never offsets into it.

## Documentation

See the [guard docs](https://vernllm.dev/docs/extensions/guard) for [checks](https://vernllm.dev/docs/extensions/guard/features/checks), [redaction](https://vernllm.dev/docs/extensions/guard/features/redaction), [streaming](https://vernllm.dev/docs/extensions/guard/features/streaming), [hosted detectors](https://vernllm.dev/docs/extensions/guard/features/hosted-detectors), [spotlight](https://vernllm.dev/docs/extensions/guard/features/spotlight), and [rollout](https://vernllm.dev/docs/extensions/guard/features/rollout).

## License

MIT
