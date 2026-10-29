<h1 align="center">vern-llm-guard</h1>

<p align="center">Checks on what goes into a <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a> call: label it for policy, redact values before the provider sees them, or block it.</p>

## Usage

```ts
import { VernLLM } from 'vern-llm';
import { guardMiddleware, guardLabels, patterns, keywords } from 'vern-llm-guard';

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

The guard sits at position `-150`: outside policy, usage and the router. A blocked call reserves no budget and opens no connection.

## Checks

| Field       | Meaning                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Unique and stable. It is in results, errors and logs                                                                            |
| `detect`    | A detector, see below                                                                                                           |
| `on`        | `'input'` (every role, the default), or any of `'user'`, `'tool'`, `'system'`, `'assistant'`, `'output'`                        |
| `action`    | `'label'` (default) adds the label for policy. `'redact'` replaces the value. `'block'` refuses the call with `content_blocked` |
| `redactFor` | `(ctx) => boolean`, for `redact` only: whether this attempt's target gets the token. Default: every target                      |
| `restore`   | For `redact` only. `true` (default) puts the value back in the answer, `false` masks it there too                               |
| `label`     | What policy sees when the check finds something. Default: the `id`                                                              |
| `when`      | `(ctx) => boolean`, whether the check applies to this call                                                                      |
| `parallel`  | `block` on input only: start with the call instead of before it, see Parallel checks                                            |
| `mode`      | `'enforce'` (default), or `'audit'` to report the would be effect and change nothing                                            |
| `timeoutMs` | Default 2000, never past the call's deadline                                                                                    |
| `onError`   | `'closed'` (default) or `'open'`, what a failing detector means                                                                 |

## Redaction

A `redact` check swaps each value for a token before the provider sees it, and swaps it back in the answer.

```ts
const guard = guardMiddleware({
  version: '1',
  key: process.env.GUARD_KEY, // 32 bytes or more, optional
  checks: [{ id: 'pii', detect: patterns(['email', 'card']), action: 'redact' }],
});
```

- Tokens are keyed HMACs, so the same value always gets the same token and nothing is stored
- An email becomes `x<hex>@redacted.invalid`, so it still passes an address check. Other values become `[LABEL_hash]`
- `redactFor` runs per attempt, so a trusted primary can see the value while a fallback gets a token
- The caller's input is never changed. Only a copy goes to the provider
- A finding without a position cannot be replaced, so a `redact` check blocks and reports it as `unredactable`
- Content added by another transform is scanned too. Give the guard the last transform place, or a warning says what escapes
- `mask(label)` sets the text for masked values. Default: `[EMAIL]`

## Output

A check with `on: 'output'` runs on the plain answer, in this order: known values become tokens, the checks run, `block` refuses and `redact` masks, then tokens are restored. Values the caller sent are never flagged on the way back. Tool call arguments are checked and restored too. Reasoning blocks are scanned, so a `block` check sees them, but never rewritten: a `redact` finding there is ignored. In JSON mode every string the model wrote is read, and a mask that lands on a bare number is written as a string so the document stays valid.

## Parallel checks

```ts
{ id: 'jailbreak', detect: llamaGuard, action: 'block', parallel: true }
```

- Starts with the call instead of before it, so a slow classifier adds no latency to calls that pass
- The answer is held until the check finishes. A streamed answer's first chunk waits for it
- On a block, a stream is cancelled and the call fails with `content_blocked`. A plain answer was already generated and billed: that is the cost of the latency win
- A check that answers synchronously and blocks stops the call before the provider is called
- It runs after policy decided, so it can only block, and only on input. Anything else is a construction error. It reads the request as the caller sent it, not text other transforms add later

## Evaluate, update and redactText

```ts
await guard.evaluate({ messages }); // the result a call would emit, no call made
await guard.evaluate({ text, phase: 'output' }); // or one piece of text, as an answer
guard.update({ checks, version: '2026-11-01.1' }); // validated first, then swapped
new VernLLM({ client, model, redact: guard.redactText, middleware: [guard] });
```

- `evaluate` runs the real detectors, `parallel` ones included, on plain data. Run it over a labeled set in CI to measure false positives before a check leaves `audit`. `context` feeds a check's `when`
- `update` needs a `version` different from the current one, so cached answers and the memo never carry across checks. `stream` options are merged into the current ones. It compiles everything before it swaps, so a bad update throws and the old checks stay. A call in flight finishes on the checks it started with. The memo starts empty, and `key`, `mask` and `memo` stay as they were
- `redactText` masks what `redact` and `block` checks find in a text, wherever they are pointed, for the core's `redact` option on its debug logs. It is synchronous, so a check that returns a promise is skipped. When a check that fails closed breaks, the whole text is masked

## Spotlight

Opt in defence against prompt injection from untrusted text, such as a web page in a tool result.

```ts
guardMiddleware({ version: '1', checks, spotlight: { sources: ['tool'] } });
```

- Spaces and tabs in the listed sources (`'tool'` by default, or `'user'`, `'assistant'`) become a marker, and one sentence is added to the system message saying marked text is data and never instructions
- The marker is random per instance and changes with `version`, so the system message is the same on every call of a version and provider prompt caching keeps working
- A marker the model echoes is turned back into a space in plain answers, streams and tool call arguments
- Redaction runs first, so a value with spaces in it is a token before the text is marked
- `'user'` tells the model the user message is untrusted data. Use it only where that is true
- It changes what the model reads. Test it on your own use case before turning it on

## Streams

A streamed answer goes through the same steps as it arrives. A call with no `redact` check that found something and no `on: 'output'` check gets its stream back untouched.

```ts
guardMiddleware({
  version: '1',
  checks,
  stream: { release: 'checked', holdChars: 128, windowChars: 1000 },
});
```

- `release: 'checked'` (default) sends text only after every check covering it passed. `'immediate'` sends first and checks after: a block ends the stream, but cannot take back what was sent, and a redaction there is counted as `late`
- Text with no whitespace, such as Chinese, is released in `holdChars` steps instead of all at the end
- `holdChars` (at least 32) is held back, so a value split over chunks is caught and a token split over chunks is restored whole
- A check that answers synchronously runs on every chunk. One that returns a promise runs once per `windowChars` of new text, and text is not sent past what it has read. With `'checked'`, the first text waits for it
- Tool call arguments are held until complete, then checked and restored
- A block cancels the provider stream, `chunks` throws `content_blocked` and `finalResult` rejects with it
- `finalResult` checks the whole answer too, so it holds for a caller that never reads `chunks`. Anything it catches that the stream let through is counted as `late`
- The `guard.result` event comes when `finalResult` settles

## Detectors

```ts
type Detector = (
  segments: readonly Segment[],
  signal: AbortSignal,
) => Finding[] | Promise<Finding[]>;
```

- Pure: findings depend only on the segments. That is what makes the memo exact
- Batched: a detector gets every segment that needs scanning in one call
- Returning an array keeps the scan synchronous. A promise is awaited, and raced against `timeoutMs`
- A threshold is one `.filter` inside your detector

Built in and dependency free: `patterns(['email', 'phone', 'card', 'iban', 'ip', 'secrets'])` with validation (Luhn, mod 97), `patterns({ label: RegExp })` and `keywords(list)`. They are heuristics, so run them in `mode: 'audit'` first.

For harmful content there is `openaiModeration({ client })`, backed by OpenAI's free Moderation API. A finding is a category, labeled `moderation.<category>`, over the whole text, so these checks label and block. `.only('self-harm', 'violence')` gives a detector for some categories that shares one request per text. It sends the checked text to OpenAI.

For rules only you can describe, such as "recommends a specific investment" or "names a competitor", there is `llmClassifier({ llm, categories })`. A model judges each text against your categories, and a finding is a category labeled `classifier.<category>`. With `quotes: true` each finding gets a span from the text the model quoted, so a `redact` check can mask it. A category with no quote, or a quote that is not found in the text, gives a finding without a span, and a `redact` check then blocks the call instead of masking. Give it its own `VernLLM`: a guard on the one it uses refuses its calls. The model sees the checked text.

## Labels for policy

```ts
import { policyMiddleware } from 'vern-llm-policy';

const policy = policyMiddleware({
  labels: guardLabels,
  rules: [{ id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } }],
});
```

`guardLabels(ctx)` returns `['pii']`, `[]` when the guard looked and found nothing, or `undefined` when it did not run or a labeling check failed. Policy reads `undefined` as unknown and applies its label rules.

## Errors

A detector that throws or times out follows `onError`. With `closed`, a blocking check blocks the call and a labeling check makes the labels unknown. With `open`, the check is skipped. Results carry the check id and the kind of error, never its message.

## Result event

Every call emits one `guard.result` before it goes on: the outcome (`passed`, `labeled`, `redacted` or `blocked`), an `output` report when the answer was checked, the labels, and per check counts, kinds and milliseconds. Never content, never offsets into it. `guardLogFields(ctx)` gives `guard_outcome`, `guard_labels` and `guard_ms` for a log record.

## Cache

`wrap` runs on cache hits and joins, so input and output checks still apply to a stored answer. A cache holds tokens, never the values a caller sent, and a hit cannot restore a value its caller did not send. Findings are remembered per text in a per call cache and a memo per instance (`memo: { max }`, or `false`). The memo holds offsets and kinds, never text.

## License

MIT
